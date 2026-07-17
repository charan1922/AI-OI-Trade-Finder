// Prints "1" if the AUTO_SHUTDOWN feature toggle is ON, else "0".
// Used by /opt/projectr/autostop.sh — its output is compared to "1".
// Fail-safe: any error / missing table / missing row → "0" (never auto-stop).
const D = require('/app/node_modules/better-sqlite3');
let on = 0;
try {
  const db = new D('/app/data/project-r.db', { readonly: true });
  const r = db.prepare("SELECT value FROM feature_toggles WHERE key='AUTO_SHUTDOWN'").get();
  on = r && Number(r.value) === 1 ? 1 : 0;
  db.close();
} catch (e) {
  on = 0;
}
process.stdout.write(String(on));
