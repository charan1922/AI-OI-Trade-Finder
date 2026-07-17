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
// --force to acknowledge. The box also auto-stops itself in the evening once the
// scheduler is wired, so you rarely need this.

import { execFileSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || process.env.PROD_BOX_REGION || 'ap-south-1';
const IP = process.env.PROD_BOX_IP || '3.108.33.64';
const HEALTH_URL = process.env.PROD_BOX_URL || 'https://charan-projectr.duckdns.org/login';
const cmd = (process.argv[2] || '').toLowerCase();
const FORCE = process.argv.includes('--force');

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
    return execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
    if (state === 'running') return log(`already running (${id}). app: ${await appHealth()}`);
    log(`starting ${id} …`);
    aws(['ec2', 'start-instances', '--region', REGION, '--instance-ids', id]);
    aws(['ec2', 'wait', 'instance-running', '--region', REGION, '--instance-ids', id]);
    log(`started. instance is running — app boots in ~30s. Check: pnpm box:status`);
    return;
  }

  // stop
  const state = powerState(id);
  if (state === 'stopped') return log(`already stopped (${id}).`);
  if (!FORCE) {
    log(`⚠ ${id} is ${state}. box:stop does NOT check for an OPEN position.`);
    log('  Make sure you are flat (check /auto-trade), then re-run: pnpm box:stop --force');
    process.exit(2);
  }
  log(`stopping ${id} …`);
  aws(['ec2', 'stop-instances', '--region', REGION, '--instance-ids', id]);
  log('stop requested. It powers down in ~30-60s. Autonomous jobs will not run until restarted.');
}

main().catch((err) => die(err.message));
