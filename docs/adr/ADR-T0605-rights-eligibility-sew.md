# ADR-T0605 — Сшивка контура прав: единый предикат активации назначения

**Status:** ready
**Phase:** DESIGN
**Task:** T-0605 [P0]
**Date:** 2026-07-03
**Спека:** `docs/specs/T-0605-rights-eligibility-sew.spec.md` + `docs/specs/T-0605.spec.contract.json` (AC-1..AC-10)
**База:** dev @ `a12b1ae` (ветка `task/T-0605-rights-eligibility-sew`)

---

## 1. Решение

**ЕДИНЫЙ источник правды «назначение роли активно» для всех читателей.** PDP-путь
(`src/db/grants-dao.ts`) схлопывается на ТОТ ЖЕ канонический предикат активации
назначения, что уже задокументирован (`src/http/rights-overview.ts:34-42`) и
применяется картой роли (`rights-overview.ts:295-298` `isActive`) и порождается
write-side (`grants.ts` POST `/api/role-assignments`; `rights-intents.ts` hire):

```
ASSIGNMENT_ACTIVE := confirmed_by IS NOT NULL
                     AND (confirmed2_by IS NOT NULL OR proposed_by IS NULL)
                     AND (valid_from IS NULL OR valid_from <= now)
                     AND (valid_until IS NULL OR valid_until > now)
```

### 1.1. Что меняется в `grants-dao.ts`

Две функции, обе — предикат активации **НАЗНАЧЕНИЯ** (`role_assignment`):

- `getRoleSlugsForActor` (JOIN `role_assignment→role`, ~`:434-446`)
- `getGrantsForSubject` step-2 (загрузка `role_assignment`, ~`:240-255`)

Было:

```sql
AND (
      ra.confirmed2_by IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM choros."grant" g
         WHERE g.tenant_id = ra.tenant_id AND g.role_id = ra.role_id
           AND g.confirmed_by IS NOT NULL
           AND (g.valid_from IS NULL OR g.valid_from <= $3)
           AND (g.valid_until IS NULL OR g.valid_until > $3)
           AND ${CRITICAL_GRANT_PREDICATE_G}
      )
    )
```

Стало:

```sql
AND (ra.confirmed2_by IS NOT NULL OR ra.proposed_by IS NULL)
```

`CRITICAL_GRANT_PREDICATE_G` из **ассignment-предиката** удаляется (после правки у
него нет потребителей — проверяется грепом перед удалением константы).

### 1.2. Что НЕ меняется

- **`getGrantsForSubject` step-3** (загрузка `grant`, `:289-317`): критичный ГРАНТ
  активен только при `confirmed2_by IS NOT NULL`. `CRITICAL_GRANT_PREDICATE_BARE` и
  функция `criticalGrantPredicate` ОСТАЮТСЯ. Это настоящий authority-гейт критичных
  прав (T-0397 B1: read-grant с sensitive clearance и т.д.) — он корректен и
  необходим.
- Fail-closed (DB-ошибка → 500), tenant-RLS, окно валидности — без изменений.

### 1.3. Web-честность

`web/src/screens/screen-inbox.jsx` — claim-обработчик показывает тост на ЛЮБУЮ
ошибку POST claim; для `NOT_ELIGIBLE` — человеческий текст: «Нет роли для этой
задачи — попросите администратора назначить роль…». Не сырой код, не молчаливый
провал (живой факт §3 приёмки: второй 403 был молчаливым).

## 2. Почему это верно (и почему НЕ «второй authority-path»)

Дуал-контроль по контракту T-0044 требует второго подтверждающего когда
критичность **ЭСКАЛИРУЕТ** (`criticalityDiff.escalates`), а НЕ для каждого
назначения к уже-критичной роли. Назначение роли не меняет грант-сет роли ⇒
`from ≡ to` ⇒ не эскалирует ⇒ write-side честно кладёт его рутинным.

T-0397 ввёл в read-path требование `confirmed2_by` **на назначении** для любой
критичной роли — требование, которое write-side НИКОГДА не выполняет для
рутинного назначения. Это самозаклин. Схлопывание на канонический предикат
**УДАЛЯЕТ вторую расходящуюся интерпретацию** «назначение активно», а не добавляет
новый путь авторизации:

- Стор ОДИН: `choros.role_assignment`. Ключ ОДИН: `employee_id` (slug→id).
- После правки PDP-read, карта роли и write-side применяют ОДИН предикат.
- Authority критичных ПРАВ остаётся ровно в одном месте — grant step-3
  (`confirmed2_by`). Мы её не дублируем и не ослабляем.

Это соответствует дисциплине репозитория «no second authority path»
(`ci/checks/agent-hire-no-second-authority.sh` и семейство isolation-чеков): мы
СХЛОПЫВАЕМ на единый источник, а не расщепляем.

## 3. Отвергнутые альтернативы

1. **Fix write-side (требовать 2-го подтверждающего для назначения к критичной
   роли).** Каждое назначение workflow-роли — двухчеловечная церемония (не
   семантика T-0044); ломает bootstrap (владелец один — второго нет); противоречит
   hire-пути, который кладёт назначение рутинным. Отвергнуто.
2. **PDP читает «оба стора» и берёт объединение.** Стор один; «оба» = увековечить
   драйф; прямое нарушение «no second authority path». Отвергнуто.
3. **Показывать держателя на карточке как «неактивного».** Лечит симптом «карточка
   врёт», не лечит корень «взять не может никто» (второго подтверждающего неоткуда
   взять). Узаконивает поломку. Отвергнуто.
4. **Feature-flag / bypass eligibility для владельца.** Кейс-специфичный обход
   (нарушение D-064), привилегированный второй путь, оставляет корень. Отвергнуто.

## 4. Миграция БД

**Не требуется.** Колонки `proposed_by`, `confirmed_by`, `confirmed2_by` уже есть
(migration 020 `role_assignment` + migration 031 `confirmed2_by`). Изменение — чисто
в SQL-предикате DAO.

## 5. Fitness-функции и трассируемость

См. `docs/adr/T-0605.adr.contract.json` (FF-1..FF-7, traceability AC↔FF). Ключевые
гейты:

- `npm run fitness:db` — обновлённый `grants-dao-dual-control.db.test.ts` (фикстуры
  честны: рутинное назначение `proposed_by=NULL`; эскалирующее `proposed_by`
  non-null) + новый `rights-eligibility-sew.db.test.ts` (сквозной claim).
- `npm test` — обновлённый `src/__tests__/grants-dao.test.ts` (mirror-предикат
  приведён к каноническому).
- `cd web && npx vitest run` — тост ошибки claim.
- `bash ci/checks/anti-case-lock.sh` — без кейс-литералов.

## 6. Эскалация

Нет. Коррекция read-предиката под уже-задокументированный контракт; удаляет
расходящуюся интерпретацию; не вводит прав/данных/секретов/authority-путей; без
миграции.
