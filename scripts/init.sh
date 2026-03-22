#!/bin/sh
# =============================================================================
# JARVIT Firecracker MicroVM Init Script (/sbin/init)
# =============================================================================
# This is PID 1 inside each Firecracker microVM. It runs on boot and:
#   1. Reads VM identity from MMDS (MicroVM Metadata Service) — with retry
#   2. Configures networking (static IP on /30 subnet)
#   3. Mounts the user's persistent data volume
#   4. Starts the JARVIT entrypoint (/opt/jarvit/entrypoint.sh)
#
# Shell: /bin/sh (busybox on Alpine — no bash available)
# =============================================================================

set -e

export PATH="/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
    echo "[jarvit-init] $1"
}

die() {
    echo "[jarvit-init] FATAL: $1" >/dev/console 2>&1
    echo "[jarvit-init] Halting VM." >/dev/console 2>&1
    sleep 2
    halt -f
}

# ---------------------------------------------------------------------------
# Step 0: Mount essential kernel filesystems
# ---------------------------------------------------------------------------
# Firecracker boots with a minimal kernel — proc/sys/dev are not mounted yet.
# We need /proc for /proc/cmdline fallback and general operation.
# We need /sys for network device management.
# We need /dev for block devices (/dev/vdb).

log "Mounting essential filesystems"
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sys /sys
mountpoint -q /dev || mount -t devtmpfs dev /dev

# Bring eth0 up early so MMDS (169.254.169.254) is reachable.
# MMDS requires a source IP on the interface for TCP — assign a temporary
# link-local address. This will be replaced with the real IP in Step 2.
ip link set eth0 up 2>/dev/null || true
ip addr add 169.254.169.1/16 dev eth0 2>/dev/null || true

# ---------------------------------------------------------------------------
# Step 1: Read identity from MMDS (MicroVM Metadata Service)
# ---------------------------------------------------------------------------
# MMDS is Firecracker's metadata service, accessible at the link-local address
# 169.254.169.254. It uses a token-based auth flow (similar to AWS IMDSv2):
#   1. PUT request to get a session token (valid for 6 hours)
#   2. GET request with that token to fetch metadata
#
# The host populates MMDS with this VM's identity before boot:
#   bundle_id      — which user/subscription this VM belongs to
#   tier           — "pro" or "hardcore" (determines resource limits)
#   hmac_token     — shared secret for authenticating with the gateway
#   gateway_url    — URL of the JARVIT gateway (for API calls out)
#   host_agent_url — URL of the host-side agent (for VM <-> host comms)
#   vm_ip          — this VM's IP address (e.g. 172.16.0.2)
#   gateway_ip     — the host-side gateway IP (e.g. 172.16.0.1)

MMDS_ADDR="http://169.254.169.254"
MMDS_OK=0

log "Reading identity from MMDS (with retry)"

# Parse JSON fields using lightweight grep/sed (no jq in Alpine base)
# Expected format: {"bundle_id":"...","tier":"...","hmac_token":"...", ...}
extract_field() {
    echo "$MMDS_JSON" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

# Retry loop: Host Agent pushes MMDS data AFTER VM boot, so the first
# attempt may arrive before metadata is ready. Try up to 5 times (1s apart)
# for a maximum ~5s total wait — well within the boot time budget.
for attempt in 1 2 3 4 5; do
    # Get session token (PUT with TTL header)
    MMDS_TOKEN=$(curl -s --connect-timeout 2 --max-time 3 -X PUT \
        -H "X-metadata-token-ttl-seconds: 21600" \
        "${MMDS_ADDR}/latest/api/token" 2>/dev/null) || true

    if [ -n "$MMDS_TOKEN" ]; then
        # Fetch the jarvit metadata blob as JSON.
        # Accept header is required — without it, MMDS returns key names only.
        MMDS_JSON=$(curl -s --connect-timeout 2 --max-time 3 \
            -H "X-metadata-token: ${MMDS_TOKEN}" \
            -H "Accept: application/json" \
            "${MMDS_ADDR}/jarvit" 2>/dev/null) || true

        if [ -n "$MMDS_JSON" ]; then
            BUNDLE_ID=$(extract_field bundle_id)
            TIER=$(extract_field tier)
            HMAC_TOKEN=$(extract_field hmac_token)
            GATEWAY_URL=$(extract_field gateway_url)
            HOST_AGENT_URL=$(extract_field host_agent_url)
            VM_IP=$(extract_field vm_ip)
            GATEWAY_IP=$(extract_field gateway_ip)

            if [ -n "$BUNDLE_ID" ] && [ -n "$TIER" ]; then
                MMDS_OK=1
                log "MMDS: bundle_id=${BUNDLE_ID} tier=${TIER} (attempt ${attempt})"
                break
            fi
        fi
    fi

    log "MMDS not ready yet (attempt ${attempt}/5), retrying in 1s..."
    sleep 1
done

# ---------------------------------------------------------------------------
# Step 1b: Fallback — read identity from kernel command line (dev mode)
# ---------------------------------------------------------------------------
# In development, we can pass identity via kernel boot parameters instead of
# MMDS. Format: jarvit.bundle_id=xxx jarvit.tier=pro jarvit.hmac_token=xxx ...

if [ "$MMDS_OK" -eq 0 ]; then
    log "MMDS unavailable, falling back to kernel cmdline"

    CMDLINE=$(cat /proc/cmdline)

    # Extract jarvit.key=value pairs from the kernel command line
    extract_cmdline() {
        echo "$CMDLINE" | tr ' ' '\n' | sed -n "s/^jarvit\.$1=//p"
    }

    BUNDLE_ID=$(extract_cmdline bundle_id)
    TIER=$(extract_cmdline tier)
    HMAC_TOKEN=$(extract_cmdline hmac_token)
    GATEWAY_URL=$(extract_cmdline gateway_url)
    HOST_AGENT_URL=$(extract_cmdline host_agent_url)
    VM_IP=$(extract_cmdline vm_ip)
    GATEWAY_IP=$(extract_cmdline gateway_ip)
    if [ -z "$BUNDLE_ID" ] || [ -z "$TIER" ]; then
        die "No identity found in MMDS or kernel cmdline. Cannot start."
    fi

    log "cmdline: bundle_id=${BUNDLE_ID} tier=${TIER}"
fi

# ---------------------------------------------------------------------------
# Step 2: Configure networking (static IP on /30 subnet)
# ---------------------------------------------------------------------------
# Each VM gets its own /30 subnet (4 IPs: network, host, vm, broadcast).
# Example: 172.16.0.0/30 -> host=172.16.0.1, vm=172.16.0.2
#
# If MMDS/cmdline didn't provide explicit IPs, derive them from
# HOST_AGENT_URL. The host agent URL contains the host-side IP
# (e.g. http://172.16.0.1:9100), and the VM IP is host_ip + 1.

if [ -z "$VM_IP" ] || [ -z "$GATEWAY_IP" ]; then
    if [ -n "$HOST_AGENT_URL" ]; then
        # Extract IP from URL like http://172.16.0.1:9100
        GATEWAY_IP=$(echo "$HOST_AGENT_URL" | sed -n 's|.*://\([0-9.]*\).*|\1|p')

        if [ -n "$GATEWAY_IP" ]; then
            # Derive VM IP: take the last octet and add 1
            # Gateway is .1, VM is .2 in the /30 subnet
            IP_PREFIX=$(echo "$GATEWAY_IP" | sed 's/\.[0-9]*$//')
            GW_LAST=$(echo "$GATEWAY_IP" | sed 's/.*\.//')
            VM_LAST=$((GW_LAST + 1))
            VM_IP="${IP_PREFIX}.${VM_LAST}"
        fi
    fi
fi

if [ -z "$VM_IP" ] || [ -z "$GATEWAY_IP" ]; then
    die "Cannot determine network configuration (no VM_IP or GATEWAY_IP)"
fi

log "Configuring eth0: ${VM_IP}/30 via ${GATEWAY_IP}"

# Remove the temporary link-local address used for MMDS access
ip addr del 169.254.169.1/16 dev eth0 2>/dev/null || true

ip addr add "${VM_IP}/30" dev eth0
ip link set eth0 up
ip route add default via "${GATEWAY_IP}"

# ---------------------------------------------------------------------------
# Step 3: DNS — intentionally disabled
# ---------------------------------------------------------------------------
# VMs must NOT resolve DNS. All external communication goes through the
# gateway (which the VM reaches by IP). This prevents:
#   - DNS exfiltration / tunneling
#   - VMs reaching arbitrary internet hosts
#   - Data leaks through DNS queries
#
# Do NOT create /etc/resolv.conf.

log "DNS disabled (by design)"

# ---------------------------------------------------------------------------
# Step 4: Mount /data volume (user's persistent storage)
# ---------------------------------------------------------------------------
# The second virtio block device (/dev/vdb) is the user's data volume.
# It persists across VM restarts and contains user files, conversation
# history, and any data the user creates.

log "Mounting /data volume (/dev/vdb)"

mkdir -p /data

if [ -b /dev/vdb ]; then
    if mount -o noexec,nosuid /dev/vdb /data 2>/dev/null; then
        log "/data mounted successfully"
    else
        log "WARNING: /dev/vdb mount failed (disk may be unformatted)"
        log "  Running without persistent storage."
    fi
else
    log "WARNING: /dev/vdb not found — running without persistent storage"
    # Not fatal: VM can still operate, just without persistent data.
    # This happens in dev/test when no data volume is attached.
fi

# ---------------------------------------------------------------------------
# Step 5: Start the JARVIT entrypoint (OpenClaw)
# ---------------------------------------------------------------------------
# Map MMDS variable names to application variable names.
# The entrypoint script handles app-level setup (config, dirs, OpenClaw).
#
# We use 'exec' so the entrypoint replaces this shell as PID 1's child.
# Signals go directly to the Node process (clean shutdown on SIGTERM).

# Map MMDS names → application names
export JARVIT_USER_ID="$BUNDLE_ID"
export JARVIT_TIER="$TIER"
export JARVIT_GATEWAY_TOKEN="$HMAC_TOKEN"
export JARVIT_GATEWAY_URL="$GATEWAY_URL"
# No HINDSIGHT_URL — memory goes through AI Proxy (Single Gateway)

log "Starting jarvit entrypoint (dropping to user: jarvit)"
log "  JARVIT_USER_ID=${JARVIT_USER_ID}"
log "  JARVIT_TIER=${JARVIT_TIER}"
log "  JARVIT_GATEWAY_URL=${JARVIT_GATEWAY_URL}"

# GitHub token no longer needed — jarvit-vm repo is public.
# Auto-update polls GitHub releases without authentication.

# Ensure /data is owned by the jarvit user so OpenClaw can write workspace data
chown -R jarvit:jarvit /data 2>/dev/null || true
chown -R jarvit:jarvit /opt/jarvit 2>/dev/null || true

# Drop privileges: init.sh ran as root for mount/network setup.
# Now hand off to the jarvit user for the actual application.
exec gosu jarvit /opt/jarvit/entrypoint.sh
