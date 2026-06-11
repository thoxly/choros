# Spec · T-0191 — PDP-гейт на PUT/PATCH /api/registry-defs/:id (force-path)

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-12
**Task:** T-0191 (product=choros, type=standard_code, prio 56)
**ADR consumed:** `docs/design/T-0121-reports-pages.adr.md`
  §5.3 (force-path escape-hatch, grant requirement),
  §6 (права — `mgmt_object:schema_destructive`/`apply`),
  §8 (FF-SOFT-WARN, FF-DESTRUCTIVE-DENY, FF-FORCE-DEMOTE)
**Reference implementation:** `src/http/notification-prefs.ts` (T-0171:
  `loadAdminContext`, exact `resourceType` match, genesis-owner short-circuit)
**Prior art:** `docs/pr/T-0171.pr-handoff.json` field `pdp_gate_evidence`

---

## 1. Summary

T-0177 оставил `TODO(T-0021)`-стаб в force-ветке `updateSchemaInTx` —
любой аутентифицированный актор мог пройти деструктивное изменение с `force=true`
без проверки гранта. Эта задача заменяет стаб реальным PDP-гейтом:
`mgmt_object:schema_destructive` / `apply` (ADR T-0121 §6).

Паттерн: injectable `RegistryDefAuthzDeps.checkDestructiveGrant` (аналог
`PrefAuthzDeps.checkAdminGrant` из T-0171): `loadAdminContext` → genesis-owner
short-circuit → `adminGrants.some(g.resourceType === 'mgmt_object:schema_destructive'
&& g.operation === 'apply')`. Без гранта → `403 NO_SCHEMA_DESTRUCTIVE_GRANT`.

**Ресурс/операция (ADR T-0121 §6):**
- `resource_type` = `"mgmt_object:schema_destructive"` — живёт как TEXT (паттерн
  T-0077 §2.2 widening-cast); вписывается в `mgmt_object:${string}` шаблон
  `ResourceType` без расширения union.
- `operation` = `"apply"` — не входит в frozen `Operation` union. Решение:
  `RegistryDefAuthzDeps` принимает `operation: string` (не `Operation`) для
  внутреннего использования; widening-cast `"apply" as unknown as Operation`
  применяется только в тестах (паттерн T-0024/T-0077). Frozen-набор не правится.

---

## 2. Functional requirements

- **FR-1** Определить injectable `RegistryDefAuthzDeps` интерфейс в
  `src/http/registry-defs.ts` с методом `checkDestructiveGrant(pool, tenantId,
  actorId, nowMs)` → `Promise<{ok:true}|{ok:false;reason:string}>`.

- **FR-2** Реализовать `defaultCheckDestructiveGrant`: `loadAdminContext` →
  genesis-owner short-circuit (всегда allowed) → `adminGrants.some(g =>
  g.delegable && g.resourceType === 'mgmt_object:schema_destructive' &&
  g.operation === 'apply')`.

- **FR-3** В force-ветке `updateSchemaInTx` (шаг 7b) заменить
  `TODO(T-0021)`-стаб на вызов `deps.checkDestructiveGrant`. Если `!ok` →
  бросить `HttpError(403, 'NO_SCHEMA_DESTRUCTIVE_GRANT', reason)`.

- **FR-4** `updateSchemaInTx` принимает `deps` как параметр (или `RegistryDefAuthzDeps`
  пробрасывается через closure/route-level). `registerRegistryDefRoutes` принимает
  `deps: RegistryDefAuthzDeps = defaultRegistryDefAuthzDeps` (аналог T-0171).

- **FR-5** TODO-стаб `// TODO(T-0021): wire real grant PDP check` и `void actor;`
  полностью удаляются из `registry-defs.ts`.

---

## 3. Non-functional requirements

- **NF-1** Нет нового ACL-механизма — только `loadAdminContext` (T-0030 + T-0018).
  `adminGrants` включает все `LIKE 'mgmt_object:%'` строки через текущий SQL в
  `org.ts` — `mgmt_object:schema_destructive` покрывается без изменений `org.ts`.

- **NF-2** Frozen `Operation` union не расширяется. `operation` в интерфейсе
  `RegistryDefAuthzDeps` — `string`, не `Operation`. Widening-cast только в тестах.

- **NF-3** `registerRegistryDefRoutes` сохраняет сигнатуру `(router, _poolHint?)`;
  добавляется необязательный третий параметр `deps?`.

- **NF-4** Невырождение T-0177-тестов: `schema_change_api.test.ts` (AC-10 / force-path)
  продолжает проходить — при отсутствии гранта в dev-тенанте AC-10 либо сидирует
  grant, либо тест использует genesis-owner (actor с ролью `tenant-owner`).

- **NF-5** tsc --noEmit exit 0; npm test exit 0; npm run fitness exit 0.

---

## 4. Out of scope

- Изменение `Operation` union или `ResourceType` union (frozen seam).
- Изменение `org.ts` / `loadAdminContext` — запрос уже включает
  `LIKE 'mgmt_object:%'` строки.
- MCP-tool для schema-change авторинга (T-0121f).
- Аудит самого PDP-check (аудит деструктива уже есть в T-0177).
- Новые миграции (grant-строки в DB добавляются тестами вручную или seeder-ом).

---

## 5. Acceptance criteria

| ID    | Описание | Тип |
|-------|----------|-----|
| AC-1  | `RegistryDefAuthzDeps` интерфейс экспортирован из `registry-defs.ts`; tsc exit 0. | fitness |
| AC-2  | `registerRegistryDefRoutes` принимает третий параметр `deps?`; default = производственный impl. | fitness |
| AC-3  | PUT/PATCH force=true без гранта → `403 NO_SCHEMA_DESTRUCTIVE_GRANT` (denyAll-fake, no-DB test). | test |
| AC-4  | PUT/PATCH force=true с грантом → `200 force_applied:true` (allowAll-fake + fake DB, no-DB test). | test |
| AC-5  | TODO-стаб и `void actor;` отсутствуют в `src/http/registry-defs.ts` (grep). | fitness |
| AC-6  | PUT/PATCH без `force` (или `force=false`) → гейт не вызывается; 409 при наличии деструктивных deps (деградация T-0177 AC-9 невырождается). | test |
| AC-7  | genesis-owner всегда проходит force-path (genesis-owner short-circuit в `defaultCheckDestructiveGrant`). | test |
| AC-8  | live: PUT force=true с сидированным грантом → 200; без гранта → 403 (fitness:db AC-10 extended). | test |
| AC-9  | `npm test` (vitest) exit 0 — все T-0177-тесты остаются зелёными. | fitness |
| AC-10 | `npm run fitness` exit 0 (включая registry-defs-pdp-isolation.sh). | fitness |

---

## 6. Design notes

### 6.1 PDP gate location

Гейт срабатывает **только** в force-ветке (шаг 7b), после того как:
1. Транзакция открыта (`BEGIN`).
2. Текущий `registry_def` залочен (`FOR UPDATE`).
3. Активные deps загружены.
4. Классификация выявила `destructiveDeps.length > 0 && force === true`.

Это соответствует ADR §5.3: гейт стоит перед применением изменений,
но внутри транзакции — если гейт вернёт 403, транзакция откатывается
(catch → ROLLBACK в `withTenantTx`).

### 6.2 Operation "apply" vs frozen union

`Operation` = `"read"|"create"|"update"|"delete"|"approve"|"transition"|"invoke"`.
`"apply"` не входит. Решение по ADR T-0121 §6 и паттерну T-0077 §2.2:
- Интерфейс `RegistryDefAuthzDeps` использует `operation: string` (не `Operation`).
- В production-коде `g.operation === "apply"` — строковое сравнение, не type-guard.
- В тестах `"apply" as unknown as Operation` если нужен cast.
- Frozen union `Operation` в `grant-lattice.ts` не меняется.

### 6.3 Невырождение AC-10 (T-0177)

T-0177 AC-10 (`force=true → dep.stale=true, page.tier='draft', audit`) использует
актора `sc-tester` (x-dev-user). После T-0191 этот тест упадёт если `sc-tester`
не является genesis-owner и не имеет гранта `mgmt_object:schema_destructive`/`apply`.

Решения (coder выбирает):
- **Опция A**: seed grant для `sc-tester` в setup-блоке теста.
- **Опция B**: использовать genesis-owner актора (slug соответствует роли `tenant-owner`).
- **Опция C**: передать `allowAll`-fake как третий параметр в `createServer(deps)` для
  тестового сервера.

Рекомендуется Опция B: `sc-tester` заменить на genesis-owner slug из dev-тенанта
(`tenant-owner`), либо seed grant в `cleanupFns`. Выбор не ограничен spec.

---

## 7. Files affected

| Файл | Изменение |
|------|-----------|
| `src/http/registry-defs.ts` | Добавить `RegistryDefAuthzDeps`, `defaultCheckDestructiveGrant`, inject `deps`, удалить TODO-стаб |
| `src/__tests__/registry-defs-pdp.test.ts` | Новый файл: unit-тесты AC-3/AC-4/AC-5/AC-6/AC-7 (no-DB, fake deps) |
| `ci/checks/db/schema_change_api.test.ts` | AC-10 extended: гарантировать прохождение force-path с правильным актором/грантом |
| `ci/checks/registry-defs-pdp-isolation.sh` | Новый fitness: grep TODO-стаб отсутствует + grep deps параметр присутствует |

---

## 8. Test strategy

**No-DB (vitest unit)** — `src/__tests__/registry-defs-pdp.test.ts`:
- `denyAllDeps`: `checkDestructiveGrant` → `{ok:false}` → 403 AC-3.
- `allowAllDeps`: `checkDestructiveGrant` → `{ok:true}` → нужен fake server
  с fake pool. Требует mock `updateSchemaInTx` или fake pool с корректными ответами.
  Упрощение: тест проверяет что гейт **вызван** и что 403 возвращается при deny —
  allow-path через live-DB тест (AC-8).
- `force=false` → гейт не вызывается (AC-6).

**Live-DB (fitness:db)** — `ci/checks/db/schema_change_api.test.ts` AC-10:
- Обновить actor / seed grant → `200 force_applied`.
- Добавить AC-10b: без гранта → `403 NO_SCHEMA_DESTRUCTIVE_GRANT`.
