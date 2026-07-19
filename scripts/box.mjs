// scripts/box.mjs
//
// Manual power control for the self-hosted AWS prod box (see memory:
// aws-box-is-prod). Railway is gone; this replaces the old `server:up/down`
// scripts that scaled the dead Railway service.
//
//   pnpm box:start    → power the EC2 instance ON  (aws ec2 start-instances)
//   pnpm box:stop     → power it OFF               (aws ec2 stop-instances)
//   pnpm box:status   → instance power state + app HTTPS health
//
// WHY aws CLI and not ssh: a STOPPED box has no OS running, so ssh cannot reach
// it — only the AWS control plane can turn it back on. So start/stop go through
// `aws ec2`, and this script needs the AWS CLI configured with an identity that
// can start/stop the instance (run `aws configure` once; ap-south-1).
//
// The instance is resolved by its Elastic IP (3.108.33.64), which stays
// associated even while the box is stopped — so `box:start` finds it fine. Set
// PROD_BOX_INSTANCE_ID to skip the lookup, or PROD_BOX_IP / AWS_REGION to point
// elsewhere.
//
// SAFETY: `box:stop` is a BLUNT operator lever — it does NOT check for an open
// position (that guard lives on the box's own scheduled shutdown, which refuses
// to power off mid-trade). Only run box:stop when you know you're flat, or pass
// --force to acknowledge.
//
// MANUAL OVERRIDES THE SCHEDULE: `box:start` drops an auto-stop HOLD on the box
// so it stays up until you run `box:stop` (which clears the hold) — a hand start
// is never powered off from under you. This needs SSH to the box (key at
// ~/.ssh/projectr-throwaway.pem, or PROD_BOX_SSH_KEY); if SSH is unavailable the
// power action still succeeds and the box's own 45-min post-start grace covers
// the gap. EventBridge's 08:15 start hits the AWS API directly, not this script,
// so scheduled mornings still auto-stop for cost saving.
//
// Automatic power on/off also exists (see docs/aws-deployment/07): EventBridge
// starts the box 08:15 IST on weekdays, and /opt/projectr/autostop.sh stops it
// after 16:30 / at weekends — but ONLY while the AUTO_SHUTDOWN toggle (/config)
// is ON, no trade is open, no hold is set, and the box is past its start grace.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Locate the aws binary. Prefer an explicit AWS_CLI_PATH, then the known
 * install locations (which work even when a freshly-opened terminal still has
 * a stale PATH — a common Windows gotcha right after installing the CLI), then
 * fall back to `aws` on PATH.
 */
function resolveAwsBin() {
  if (process.env.AWS_CLI_PATH && existsSync(process.env.AWS_CLI_PATH)) return process.env.AWS_CLI_PATH;
  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA)
      candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Amazon', 'AWSCLIV2', 'aws.exe'));
    candidates.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'Amazon', 'AWSCLIV2', 'aws.exe'));
  } else {
    candidates.push('/usr/local/bin/aws', '/usr/bin/aws', '/opt/homebrew/bin/aws');
  }
  return candidates.find((c) => existsSync(c)) || 'aws';
}
const AWS_BIN = resolveAwsBin();

const REGION = process.env.AWS_REGION || process.env.PROD_BOX_REGION || 'ap-south-1';
const IP = process.env.PROD_BOX_IP || '3.108.33.64';
const HEALTH_URL = process.env.PROD_BOX_URL || 'https://charan-projectr.duckdns.org/login';
const cmd = (process.argv[2] || '').toLowerCase();
const FORCE = process.argv.includes('--force');

// SSH into the box to manage the auto-stop HOLD file (see below). Optional: if
// the key is missing or SSH fails, power control still works — the hold is a
// best-effort override on top of the 45-min post-start grace.
const SSH_USER = process.env.PROD_BOX_SSH_USER || 'ubuntu';
const SSH_KEY = process.env.PROD_BOX_SSH_KEY || join(homedir(), '.ssh', 'projectr-throwaway.pem');
const HOLD_PATH = '/opt/projectr/autostop.hold';

/**
 * Manual box:start/stop must OVERRIDE the automatic on/off schedule: a
 * deliberate start keeps the box up until the operator stops it (not just the
 * 45-min grace), and a deliberate stop clears that override so the normal
 * schedule resumes next time. This is done via the box's autostop.hold file
 * (autostop.sh skips while it exists). EventBridge's 08:15 start calls the AWS
 * API directly, NOT this script, so it never sets a hold — cost-saving
 * auto-stop still works on scheduled mornings.
 *
 * `set`   → create an indefinite hold (manual start).
 * `clear` → remove it (manual stop).
 * Best-effort: a failure is warned, never fatal (power control already ran).
 */
function manageHold(action) {
  if (!existsSync(SSH_KEY)) {
    log(`note: SSH key ${SSH_KEY} not found — skipping auto-stop ${action} (set PROD_BOX_SSH_KEY to enable).`);
    return;
  }
  const remote =
    action === 'set'
      ? `sudo touch ${HOLD_PATH} && echo held`
      : `sudo rm -f ${HOLD_PATH} && echo cleared`;
  try {
    execFileSync(
      'ssh',
      [
        '-i', SSH_KEY,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=20',
        `${SSH_USER}@${IP}`,
        remote,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    log(action === 'set' ? 'auto-stop HOLD set — box stays up until `pnpm box:stop`.' : 'auto-stop hold cleared — normal schedule resumes.');
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim() || err.message;
    log(`warn: could not ${action} auto-stop hold over SSH (${stderr}). 45-min post-start grace still applies.`);
  }
}

function log(msg) {
  process.stdout.write(`[box] ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`[box] ${msg}\n`);
  process.exit(1);
}

/** Run the aws CLI and return trimmed stdout. Throws with a readable message. */
function aws(args) {
  try {
    return execFileSync(AWS_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    if (err.code === 'ENOENT') {
      die('AWS CLI not found. Install it and run `aws configure` (region ap-south-1) first.\n' + 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html');
    }
    throw new Error(stderr || err.message);
  }
}

/** Resolve the instance id: explicit env wins, else look it up by Elastic IP. */
function instanceId() {
  if (process.env.PROD_BOX_INSTANCE_ID) return process.env.PROD_BOX_INSTANCE_ID;
  const out = aws([
    'ec2',
    'describe-instances',
    '--region',
    REGION,
    '--filters',
    `Name=network-interface.association.public-ip,Values=${IP}`,
    '--query',
    'Reservations[].Instances[].InstanceId',
    '--output',
    'text',
  ]);
  const id = out.split(/\s+/).filter(Boolean)[0];
  if (!id) {
    die(
      `Could not find an instance with Elastic IP ${IP} in ${REGION}.\n` +
        'Set PROD_BOX_INSTANCE_ID=i-xxxx to point at it directly, or check AWS creds/region.'
    );
  }
  return id;
}

function powerState(id) {
  return aws([
    'ec2',
    'describe-instances',
    '--region',
    REGION,
    '--instance-ids',
    id,
    '--query',
    'Reservations[].Instances[].State.Name',
    '--output',
    'text',
  ]);
}

/** Best-effort app reachability check over HTTPS (200/302 = up). No auth. */
async function appHealth() {
  try {
    const res = await fetch(HEALTH_URL, { redirect: 'manual' });
    return `HTTP ${res.status}`;
  } catch (err) {
    return `unreachable (${err.cause?.code || err.message})`;
  }
}

async function main() {
  if (!['start', 'stop', 'status'].includes(cmd)) {
    die('usage: pnpm box:<start|stop|status>');
  }
  const id = instanceId();

  if (cmd === 'status') {
    const state = powerState(id);
    log(`instance ${id} (${REGION}) : ${state}`);
    if (state === 'running') log(`app ${HEALTH_URL} : ${await appHealth()}`);
    return;
  }

  if (cmd === 'start') {
    const state = powerState(id);
    if (state === 'running') {
      log(`already running (${id}). app: ${await appHealth()}`);
      manageHold('set'); // ensure a manual start always holds, even if it was already up
      return;
    }
    log(`starting ${id} …`);
    aws(['ec2', 'start-instances', '--region', REGION, '--instance-ids', id]);
    aws(['ec2', 'wait', 'instance-running', '--region', REGION, '--instance-ids', id]);
    log(`started. instance is running — app boots in ~30s. Check: pnpm box:status`);
    // Give sshd a moment after instance-running before the hold call.
    await new Promise((r) => setTimeout(r, 15_000));
    manageHold('set');
    return;
  }

  // stop
  const state = powerState(id);
  if (state === 'stopped') {
    manageHold('clear'); // no-op if unreachable; keeps the schedule clean
    return log(`already stopped (${id}).`);
  }
  if (!FORCE) {
    log(`⚠ ${id} is ${state}. box:stop does NOT check for an OPEN position.`);
    log('  Make sure you are flat (check /auto-trade), then re-run: pnpm box:stop --force');
    process.exit(2);
  }
  // Clear the hold BEFORE powering off (SSH needs the box up).
  manageHold('clear');
  log(`stopping ${id} …`);
  aws(['ec2', 'stop-instances', '--region', REGION, '--instance-ids', id]);
  log('stop requested. It powers down in ~30-60s. Autonomous jobs will not run until restarted.');
}

main().catch((err) => die(err.message));
