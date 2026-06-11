#!/usr/bin/env bash
# FF-5 + FF-8: pack integrity — meta.name == directory name; all cross-refs resolve;
# rights_cards[].role_slug ⊆ roles[].slug.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

node - "$REPO_ROOT"/seed/*/pack.json <<'NODEJS'
const fs = require('fs');
const path = require('path');
const packs = process.argv.slice(2);
let failed = false;

for (const packFile of packs) {
  const packName = path.basename(path.dirname(packFile));
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  } catch(e) {
    console.error(`FAIL: Cannot parse ${packFile}: ${e.message}`);
    failed = true;
    continue;
  }

  // FF-5: meta.name == directory name
  if (pack.meta.name !== packName) {
    console.error(`FAIL: ${packFile}: meta.name '${pack.meta.name}' != directory name '${packName}'`);
    failed = true;
  }

  const deptSlugs = new Set(pack.departments.map(d => d.slug));
  const posSlugs = new Set(pack.positions.map(p => p.slug));
  const empSlugs = new Set(pack.employees.map(e => e.slug));
  const roleSlugs = new Set(pack.roles.map(r => r.slug));

  // FF-5: position.department_slug must be in departments
  for (const pos of pack.positions) {
    if (!deptSlugs.has(pos.department_slug)) {
      console.error(`FAIL: ${packFile}: position '${pos.slug}' has unknown department_slug '${pos.department_slug}'`);
      failed = true;
    }
  }

  // FF-5: employee.position_slug must be in positions or null
  for (const emp of pack.employees) {
    if (emp.position_slug !== null && emp.position_slug !== undefined && !posSlugs.has(emp.position_slug)) {
      console.error(`FAIL: ${packFile}: employee '${emp.slug}' has unknown position_slug '${emp.position_slug}'`);
      failed = true;
    }
  }

  // FF-5: role_assignment employee_slug and role_slug must resolve
  for (const ra of pack.role_assignments) {
    if (!empSlugs.has(ra.employee_slug)) {
      console.error(`FAIL: ${packFile}: role_assignment has unknown employee_slug '${ra.employee_slug}'`);
      failed = true;
    }
    if (!roleSlugs.has(ra.role_slug)) {
      console.error(`FAIL: ${packFile}: role_assignment has unknown role_slug '${ra.role_slug}'`);
      failed = true;
    }
  }

  // FF-8: rights_cards[].role_slug ⊆ roles[].slug
  for (const card of pack.rights_cards) {
    if (!roleSlugs.has(card.role_slug)) {
      console.error(`FAIL: ${packFile}: rights_cards entry role_slug '${card.role_slug}' not in roles[].slug (FF-8)`);
      failed = true;
    }
  }

  if (!failed) {
    console.log(`OK: ${packFile}`);
  }
}

if (failed) process.exit(1);
NODEJS

echo "FF-5+FF-8: pack-refs-resolve PASS"
