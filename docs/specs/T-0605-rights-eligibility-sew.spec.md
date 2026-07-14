# T-0605 — Спека: сшивка контура прав (назначение роли → eligibility в инбоксе)

**Status:** ready
**Phase:** SPEC
**Task:** T-0605 [P0]
**Date:** 2026-07-03
**База:** dev @ `a12b1ae` (ветка `task/T-0605-rights-eligibility-sew`)

---

## 1. Контекст (живой факт приёмки, тенант Аксон, стенд, 2026-07-03)

Контур прав разорван — назначение роли на экране «Доступ» не даёт eligibility в
инбоксе:

1. Pool-задача движка с candidate group роли («Заказ поставщику»). `POST
   /api/inbox/:id/claim` → **403 NOT_ELIGIBLE** у владельца тенанта.
2. Владелец выдал себе роль через UI `/rights` («Назначить роль сотруднику»:
   сотрудник → роль → узел «Компания») — назначение прошло, держатель
   **отображается на карточке роли**. Claim ВСЁ РАВНО 403.
3. Второй 403 «Взять» — **молчаливый** (первый раз был тост «Ошибка:
   NOT_ELIGIBLE», второй — ничего).
4. Итог: задачи пула не может взять НИКТО в тенанте (включая seed-держателя
   «снабженца») → сквозной кейс закупки непроходим.

## 2. Разведка — карта разрыва (что куда пишет/читает, file:line)

**ГЛАВНЫЙ ВЫВОД: разрыв — НЕ два стора и НЕ identity-ключ. Один стор
(`choros.role_assignment`), один ключ (`employee_id`, slug→id). Расходятся
ПРЕДИКАТЫ АКТИВНОСТИ назначения между PDP и картой роли/write-side.**

### 2.1. Запись (экран «Доступ» → сервер)

| что | file:line | ключ / состояние |
|---|---|---|
| Web «Назначить роль» | `web/src/screens/rights/ra-overview-forms.jsx:56-65` | POST `/api/role-assignments`, `employee_id` = `employee.id` (UUID из дропдауна, `:213` `value: e.id`) |
| Сервер write | `src/http/grants.ts:1052-1214` → INSERT `:1160` | `role_assignment(employee_id, role_id, org_scope, proposed_by, confirmed_by, confirmed2_by)` |
| Дуал-контроль назначения | `src/http/grants.ts:1145-1156` | `from = to = combineCriticality(roleGrants)` ⇒ `criticalityDiff.escalates=false` ⇒ `required_approvers=1` ⇒ рутинно: `proposed_by=NULL, confirmed_by=actor, confirmed2_by=NULL` |
| Hire (для сравнения) | `src/http/rights-intents.ts:428-436` | назначение всегда рутинно-активно (`proposed_by=NULL`); дуал-контроль вешается на ГРАНТЫ (`:458-464`) |

**Вывод write-side:** назначение роли НЕ меняет грант-сет роли ⇒ по критичности
`from ≡ to` ⇒ **никогда не эскалирует** ⇒ write-side честно кладёт назначение
рутинным (один подтверждающий, `confirmed2_by=NULL`), и UI рапортует «Роль
назначена». Дуал-контроль живёт на ГРАНТАХ, не на назначениях.

### 2.2. Чтение №1 — карточка роли (что видит админ)

| что | file:line | предикат активности |
|---|---|---|
| Endpoint | `src/http/rights-overview.ts:421` GET `/api/rights/tenant-state` | — |
| **Канонический контракт** | `src/http/rights-overview.ts:34-42` (док) | — |
| `isActive` | `src/http/rights-overview.ts:295-298` | `confirmed_by IS NOT NULL AND (confirmed2_by IS NOT NULL OR proposed_by IS NULL) AND in-window` |

Рутинное назначение (`proposed_by=NULL`) проходит `proposed_by IS NULL` ⇒ держатель
**активен на карточке**. Это и есть «держатель отображается».

### 2.3. Чтение №2 — PDP (что решает claim)

| что | file:line | предикат активности НАЗНАЧЕНИЯ |
|---|---|---|
| Claim-гейт | `src/http/inbox.ts:1349-1355` | `myRoles = resolveRolesForActor(...)`; `taskRole ∉ myRoles ⇒ 403` |
| resolveRolesForActor | `src/http/inbox.ts:285-299` → `getRoleSlugsForActor` | — |
| **PDP-предикат** | `src/db/grants-dao.ts:434-446` (и `getGrantsForSubject` step-2 `:240-255`) | `ra.confirmed2_by IS NOT NULL OR NOT EXISTS(критичный грант роли)` |

Роль pool-задачи движка держит `approve`/`transition`-грант (ось a
`criticalGrantPredicate`, `grants-dao.ts:132-136`) ⇒ `NOT EXISTS` = **false** ⇒
для активации назначения PDP требует `confirmed2_by IS NOT NULL`. Но write-side
положил `confirmed2_by=NULL` (рутинно). ⇒ назначение **исключено** ⇒ slug роли
не в `myRoles` ⇒ **403 NOT_ELIGIBLE**.

### 2.4. Диагноз — самозаклин read/write асимметрии дуал-контроля

- **Write** ключует второго подтверждающего на **ЭСКАЛАЦИИ** критичности
  (`criticalityDiff.escalates`) — для назначения всегда false.
- **PDP-read** (введён T-0397, `grants-dao.ts`) ключует активацию назначения на
  **АБСОЛЮТНОЙ** критичности роли (держит ли роль критичный грант) — для любой
  workflow-роли true.
- Расхождение: назначение к уже-критичной роли — «рутинное» для writer, но
  «требует 2-го» для PDP-reader. Второго взять неоткуда (владелец в тенанте один
  на bootstrap). **Держатель видим на карточке (§2.2 проходит `proposed_by IS
  NULL`), невидим для PDP (§2.3 нет `confirmed2_by`).** Ровно симптом приёмки:
  карточка показывает держателя, claim — 403.
- Seed-«снабженец» падает по ТОЙ ЖЕ причине (его роль тоже критичная workflow-роль).

### 2.5. Что ОТВЕРГНУТО как причина

- **Два стора** — нет: и запись, и оба чтения → `choros.role_assignment`.
- **Identity-разрыв** (пустое имя / UUID-отображение) — нет: и запись, и чтение
  ключуются `employee_id`; дропдаун (`ra-overview-forms.jsx:213`) шлёт `employee.id`
  = тот же UUID, что PDP резолвит через `slug → employee.id`
  (`grants-dao.ts:393-397`). Пустой `display_name` — косметика, не влияет на гейт.

## 3. Решение (одной фразой)

Схлопнуть предикат активации НАЗНАЧЕНИЯ в PDP (`grants-dao.ts`) на ЕДИНЫЙ
канонический предикат, уже задокументированный в `rights-overview.ts:34-42` и
применяемый картой роли + write-side:

```
ASSIGNMENT_ACTIVE := confirmed_by IS NOT NULL
                     AND (confirmed2_by IS NOT NULL OR proposed_by IS NULL)
                     AND in-window
```

Grant-уровневый дуал-контроль (критичный ГРАНТ активен лишь при `confirmed2_by`)
**НЕ ТРОГАЕТСЯ** — это настоящий authority-гейт критичных прав. Плюс web-честность:
ошибка claim ВСЕГДА показывается человеческим текстом.

## 4. Границы (D-064, закон границы)

НИКАКИХ кейс-литералов (`procurement`/`снабженец`/конкретный слаг роли) в `src/`.
Слаги ролей приходят из данных. Изменение — чисто в SQL-предикате DAO + web-тост.

## 5. Acceptance criteria

См. `docs/specs/T-0605.spec.contract.json` (AC-1..AC-10). Кратко:

- **AC-1/AC-2** — рутинное назначение к критичной роли даёт slug; semi-confirmed
  (эскалирующее) — нет.
- **AC-3** — grant-уровневый дуал-контроль цел.
- **AC-4** — сквозной claim после назначения (live PG); не-держатель → 403.
- **AC-5/AC-10** — web показывает ошибку claim человеческим текстом.
- **AC-6** — anti-case-lock зелёный.
- **AC-7/AC-8/AC-9** — npm test / build / fitness:db зелёные.

## 6. Вне рамок

`O1` write-side дуал-контроль назначений (корректен). `O2` grant-уровневый гейт
(корректен). `O3` identity/пустое имя (отвергнуто как причина). `O4` общий
рефактор молчаливых ошибок web (follow-up).
