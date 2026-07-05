/**
 * T-0519 (D7-5 · spec T-0402) — Floor-Boundary Classifier
 * Unit tests for classifyFloorBoundary (src/core/floor-boundary.ts).
 *
 * AC coverage (docs/specs/floor-boundary.spec.contract.json):
 *   FB-1 — Floor-1 ⟺ R-1∧R-2∧R-3∧R-4; нарушение одного R → Floor-2; все 4 → Floor-1.
 *   FB-2 — контентный детектор ловит код-сигнал мимо лексики (relabel_field +
 *          custom-узел / reactSource / новый fieldKey → Floor-2).
 *   FB-3 — монотонность floor=max(lexical,content): Floor-2-kind с декларативным телом
 *          остаётся Floor-2.
 *   FB-4 — R-4 по 4 каналам: fieldKey/subKey/displayField-висящий → Floor-2; all-valid → R-4 ок.
 *   FB-5 — custom-узел/reactSource → route='sandbox'; custom → требует FLOOR2_CUSTOM_FLAG_KEY;
 *          делегирование validateFloor2Descriptor (не реимплементация).
 *   FB-6 — детерминизм + fail-closed: неизвестный kind / неоднозначный вход → Floor-2;
 *          повтор того же входа → байт-идентичный результат.
 *
 * No DB, no network, no process.env — pure unit tests.
 */

import { describe, it, expect } from "vitest";
import {
  classifyFloorBoundary,
  FLOOR1_DECLARATIVE_WHITELIST,
  FLOOR1_DOC_NODE_TYPES,
  type FloorEditOp,
  type LiveSchemaView,
  type FormDocument,
} from "../core/floor-boundary.js";
import {
  FLOOR2_CUSTOM_FLAG_KEY,
  type Floor2RenderDescriptor,
} from "../core/floor2-renderer.js";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

/**
 * Живая схема. T-0680: top-level `fieldKeys` содержит ТОЛЬКО top-level поля
 * record_schema (amount/counterparty/items/total/name). Суб-ключи коллекции
 * `items` (product/quantity) живут во ВЛОЖЕННОЙ sub-schema — `subKeysByCollection`,
 * а НЕ в плоском `fieldKeys` (раньше их приходилось туда «подкладывать»
 * обходным путём, что и маскировало LIVE-дефект T-0678). `ghost_col` намеренно
 * отсутствует в sub-schema `items` → настоящий висящий столбец остаётся Floor-2.
 */
const SCHEMA: LiveSchemaView = {
  fieldKeys: ["amount", "counterparty", "items", "total", "name"],
  subKeysByCollection: { items: ["product", "quantity"] },
  fields: [
    { key: "amount", type: "number", required: true, label: "Сумма" },
    { key: "name", type: "text", required: false, label: "Имя" },
  ],
};

/** Декларативный документ, все ключи которого ⊆ SCHEMA (валидный R-4). */
function validDoc(): FormDocument {
  return {
    type: "root",
    children: [
      {
        type: "section",
        title: "Заявка",
        children: [
          {
            type: "columns",
            count: 2,
            children: [
              { type: "field", fieldKey: "amount", widget: "money", label: "Сумма" },
              {
                type: "relation",
                fieldKey: "counterparty",
                widget: "record-picker",
                displayField: "name",
              },
            ],
          },
          {
            type: "table",
            fieldKey: "items",
            columns: [
              { subKey: "product", widget: "text" },
              { subKey: "quantity", widget: "number" },
            ],
          },
          { type: "readout", fieldKey: "total", label: "Итого" },
        ],
      },
    ],
  };
}

/** Базовая Floor-1 операция: relabel_field, whitelist-ключи, валидный документ. */
function floor1Op(overrides: Partial<FloorEditOp> = {}): FloorEditOp {
  return {
    kind: "relabel_field",
    changedKeys: ["label"],
    doc: validDoc(),
    ...overrides,
  };
}

// ===========================================================================
// FB-1 — Floor-1 ⟺ R-1 ∧ R-2 ∧ R-3 ∧ R-4
// ===========================================================================

describe("FB-1: Floor-1 ⟺ R-1 ∧ R-2 ∧ R-3 ∧ R-4", () => {
  it("all four R satisfied → Floor-1 / declarative", () => {
    const r = classifyFloorBoundary(floor1Op(), SCHEMA);
    expect(r.floor).toBe("1");
    expect(r.route).toBe("declarative");
    expect(r.reasons).toEqual([]);
    expect(r.floor2Sub).toBeUndefined();
  });

  // Parametrized: each row breaks exactly one R; expect Floor-2.
  const breakers: Array<{ name: string; op: FloorEditOp; ruleTag: string }> = [
    {
      name: "R-1 broken: Floor-2 kind",
      op: floor1Op({ kind: "add_field" }),
      ruleTag: "R-1",
    },
    {
      name: "R-1 broken: unknown kind",
      op: floor1Op({ kind: "frobnicate" }),
      ruleTag: "R-1",
    },
    {
      name: "R-2 broken: changed key outside whitelist",
      op: floor1Op({ changedKeys: ["fieldKey"] }),
      ruleTag: "R-2",
    },
    {
      name: "R-2 broken: changed contract key",
      op: floor1Op({ changedKeys: ["contract"] }),
      ruleTag: "R-2",
    },
    {
      name: "R-3 broken: custom node in doc",
      op: floor1Op({
        doc: {
          type: "root",
          children: [{ type: "custom", componentId: "gantt-1", bindings: ["amount"] }],
        },
      }),
      ruleTag: "R-3",
    },
    {
      name: "R-4 broken: dangling fieldKey",
      op: floor1Op({
        doc: { type: "root", children: [{ type: "field", fieldKey: "ghost_key" }] },
      }),
      ruleTag: "R-4",
    },
  ];

  for (const { name, op, ruleTag } of breakers) {
    it(`${name} → Floor-2`, () => {
      const r = classifyFloorBoundary(op, SCHEMA);
      expect(r.floor).toBe("2");
      expect(r.route).toBe("sandbox");
      expect(r.reasons.some((x) => x.startsWith(ruleTag))).toBe(true);
    });
  }
});

// ===========================================================================
// FB-2 — content detector catches code signal lexicon misses
// ===========================================================================

describe("FB-2: content detector beats lexical relabel_field", () => {
  it("relabel_field + custom node → Floor-2 (R-3)", () => {
    const r = classifyFloorBoundary(
      floor1Op({
        doc: {
          type: "root",
          children: [{ type: "custom", componentId: "x", bindings: ["amount"] }],
        },
      }),
      SCHEMA,
    );
    expect(r.floor).toBe("2");
    expect(r.reasons.some((x) => x.startsWith("R-3"))).toBe(true);
  });

  it("relabel_field + non-empty reactSource on a field node → Floor-2 (R-3)", () => {
    const r = classifyFloorBoundary(
      floor1Op({
        doc: {
          type: "root",
          children: [
            { type: "field", fieldKey: "amount", reactSource: "() => <div/>" } as never,
          ],
        },
      }),
      SCHEMA,
    );
    expect(r.floor).toBe("2");
    expect(r.reasons.some((x) => x.startsWith("R-3"))).toBe(true);
  });

  it("relabel_field + new (dangling) fieldKey → Floor-2 (R-4)", () => {
    const r = classifyFloorBoundary(
      floor1Op({
        doc: { type: "root", children: [{ type: "field", fieldKey: "brand_new" }] },
      }),
      SCHEMA,
    );
    expect(r.floor).toBe("2");
    expect(r.reasons.some((x) => x.startsWith("R-4"))).toBe(true);
  });

  // B-1 regression: code signal / dangling binding ON THE ROOT must lift the floor.
  const rootBypasses: Array<{ name: string; doc: FormDocument; ruleTag: string }> = [
    {
      name: "reactSource on root",
      doc: { type: "root", reactSource: "evil()", children: [{ type: "field", fieldKey: "amount" }] },
      ruleTag: "R-3",
    },
    {
      name: "componentId on root",
      doc: { type: "root", componentId: "evil-comp", children: [{ type: "field", fieldKey: "amount" }] } as never,
      ruleTag: "R-3",
    },
    {
      name: "script on root",
      doc: { type: "root", script: "alert(1)", children: [{ type: "field", fieldKey: "amount" }] } as never,
      ruleTag: "R-3",
    },
    {
      name: "dangling fieldKey on root",
      doc: { type: "root", fieldKey: "GHOST_ROOT", children: [{ type: "field", fieldKey: "amount" }] } as never,
      ruleTag: "R-4",
    },
    {
      name: "anomalous root type (outside whitelist)",
      doc: { type: "weird_root", children: [{ type: "field", fieldKey: "amount" }] } as never,
      ruleTag: "R-3",
    },
  ];

  for (const { name, doc, ruleTag } of rootBypasses) {
    it(`B-1: ${name} → Floor-2 (no root bypass)`, () => {
      const r = classifyFloorBoundary(floor1Op({ doc }), SCHEMA);
      expect(r.floor).toBe("2");
      expect(r.route).toBe("sandbox");
      expect(r.reasons.some((x) => x.startsWith(ruleTag))).toBe(true);
    });
  }

  it("NB-1: reactSource inside table.columns[] object → Floor-2 (R-3)", () => {
    const r = classifyFloorBoundary(
      floor1Op({
        doc: {
          type: "root",
          children: [
            {
              type: "table",
              fieldKey: "items",
              columns: [{ subKey: "amount", reactSource: "evil()" }],
            },
          ],
        },
      }),
      SCHEMA,
    );
    expect(r.floor).toBe("2");
    expect(r.reasons.some((x) => x.startsWith("R-3"))).toBe(true);
  });

  it("negative control: valid root type:'section' + valid children + Floor-1 kind → Floor-1", () => {
    const r = classifyFloorBoundary(
      {
        kind: "relabel_field",
        changedKeys: ["label"],
        doc: { type: "section", title: "X", children: [{ type: "field", fieldKey: "amount" }] },
      },
      SCHEMA,
    );
    expect(r.floor).toBe("1");
    expect(r.reasons).toEqual([]);
  });

  it("empty reactSource is NOT a code signal (structural, not heuristic)", () => {
    const r = classifyFloorBoundary(
      floor1Op({
        doc: {
          type: "root",
          children: [{ type: "field", fieldKey: "amount", reactSource: "  " } as never],
        },
      }),
      SCHEMA,
    );
    expect(r.floor).toBe("1");
  });
});

// ===========================================================================
// FB-3 — monotonicity: content never lowers the floor
// ===========================================================================

describe("FB-3: floor = max(lexicalFloor, contentFloor) — monotone", () => {
  const floor2Kinds = [
    "add_field",
    "drop_field",
    "rename_field",
    "type_change",
    "add_conditional",
    "custom_component",
    "external_task",
    "object_migration",
  ];

  for (const kind of floor2Kinds) {
    it(`Floor-2 kind "${kind}" with purely-declarative body stays Floor-2`, () => {
      const r = classifyFloorBoundary(
        // declarative body + whitelist keys; only the kind is Floor-2.
        { kind, changedKeys: ["label"], doc: validDoc() },
        SCHEMA,
      );
      expect(r.floor).toBe("2");
      expect(r.route).toBe("sandbox");
      expect(r.reasons.some((x) => x.startsWith("R-1") || x.startsWith("R-3"))).toBe(true);
    });
  }
});

// ===========================================================================
// FB-4 — R-4 named-binding integrity, three channels (parametrized matrix)
// ===========================================================================

describe("FB-4: R-4 three binding channels", () => {
  const matrix: Array<{ name: string; doc: FormDocument; expectFloor: "1" | "2" }> = [
    {
      name: "(a) fieldKey-dangling",
      doc: { type: "root", children: [{ type: "field", fieldKey: "nope" }] },
      expectFloor: "2",
    },
    {
      name: "(b) subKey-dangling (top-level fieldKey valid)",
      doc: {
        type: "root",
        children: [
          {
            type: "table",
            fieldKey: "items", // valid top-level
            columns: [{ subKey: "ghost_col", widget: "text" }], // dangling
          },
        ],
      },
      expectFloor: "2",
    },
    {
      name: "(c) displayField-dangling",
      doc: {
        type: "root",
        children: [
          {
            type: "relation",
            fieldKey: "counterparty",
            widget: "record-picker",
            displayField: "ghost_display",
          },
        ],
      },
      expectFloor: "2",
    },
    {
      name: "(d) all-valid — all three channels ⊆ schema",
      doc: validDoc(),
      expectFloor: "1",
    },
  ];

  for (const { name, doc, expectFloor } of matrix) {
    it(`${name} → Floor-${expectFloor}`, () => {
      const r = classifyFloorBoundary(floor1Op({ doc }), SCHEMA);
      expect(r.floor).toBe(expectFloor);
      if (expectFloor === "2") {
        expect(r.reasons.some((x) => x.startsWith("R-4"))).toBe(true);
      }
    });
  }

  it("(b) subKey-dangling holds even though R-1/R-2/R-3 pass", () => {
    const r = classifyFloorBoundary(
      floor1Op({
        doc: {
          type: "root",
          children: [
            { type: "table", fieldKey: "items", columns: [{ subKey: "ghost_col" }] },
          ],
        },
      }),
      SCHEMA,
    );
    expect(r.floor).toBe("2");
    // only R-4 should be the lifter (R-1/R-2/R-3 clean)
    expect(r.reasons.every((x) => x.startsWith("R-4"))).toBe(true);
  });
});

// ===========================================================================
// T-0680 PIN — R-4 канал 2: суб-ключи коллекции покрыты РОДИТЕЛЬСКИМ биндингом,
// НЕ висят на top-level `fieldKeys` (LIVE-дефект T-0678: форма с таблицей
// «Позиции» → ложный 409 WRONG_FLOOR, из-за чего live-proof пришлось удалить
// таблицу). МУТАЦИОННО-КРАСНЫЙ: revert канала-2 (subKey обратно в плоский
// keySet) → кейс «table + валидные суб-ключи вне top-level» краснеет Floor-2.
// ===========================================================================

describe("T-0680 PIN: collection subKeys covered by parent binding (R-4 channel 2)", () => {
  // Таблица «Позиции» с ДВУМЯ колонками, привязанная к живой коллекции `items`.
  // subKey'и product/quantity ЖИВУТ во вложенной sub-schema — их НЕТ в top-level
  // fieldKeys. До фикса subKey сваливался в плоский keySet и сверялся с top-level
  // → ложный «висящий биндинг» → Floor-2 → 409.
  const tableDoc: FormDocument = {
    type: "root",
    children: [
      {
        type: "table",
        fieldKey: "items",
        columns: [
          { subKey: "product", widget: "text" },
          { subKey: "quantity", widget: "number" },
        ],
      },
    ],
  };

  it("table + valid collection + valid columns (via sub-schema) → Floor-1 (was false 409)", () => {
    const r = classifyFloorBoundary(floor1Op({ doc: tableDoc }), SCHEMA);
    expect(r.reasons.filter((x) => x.startsWith("R-4"))).toEqual([]);
    expect(r.floor).toBe("1");
  });

  it("subKeys covered by parent EVEN when no sub-schema map is supplied (legacy caller)", () => {
    // subKeysByCollection ОТСУТСТВУЕТ — subKey всё равно покрыт живым родителем
    // `items` (родитель проверен каналом 1), НЕ висит. product/quantity намеренно
    // НЕ в top-level fieldKeys → до фикса это был бы Floor-2.
    const noSubSchema: LiveSchemaView = { fieldKeys: ["items", "amount"] };
    const r = classifyFloorBoundary(floor1Op({ doc: tableDoc }), noSubSchema);
    expect(r.reasons.filter((x) => x.startsWith("R-4"))).toEqual([]);
    expect(r.floor).toBe("1");
  });

  it("NEGATIVE — a genuinely dangling column (not in sub-schema) STILL → Floor-2", () => {
    // R-4 НЕ ослаблен в обратную: настоящий битый столбец ловится через sub-schema.
    const badCol: FormDocument = {
      type: "root",
      children: [
        { type: "table", fieldKey: "items", columns: [{ subKey: "ghost_col", widget: "text" }] },
      ],
    };
    const r = classifyFloorBoundary(floor1Op({ doc: badCol }), SCHEMA);
    expect(r.floor).toBe("2");
    expect(r.reasons.some((x) => x.startsWith("R-4"))).toBe(true);
  });

  it("NEGATIVE — a table bound to a NON-existent collection STILL → Floor-2 (parent dangling)", () => {
    // Канал 1: fieldKey table-узла нет в живой схеме → висящий родитель.
    const ghostTable: FormDocument = {
      type: "root",
      children: [
        { type: "table", fieldKey: "nope_collection", columns: [{ subKey: "product" }] },
      ],
    };
    const r = classifyFloorBoundary(floor1Op({ doc: ghostTable }), SCHEMA);
    expect(r.floor).toBe("2");
    expect(r.reasons.some((x) => x.startsWith("R-4"))).toBe(true);
  });
});

// ===========================================================================
// FB-5 — custom/reactSource → route='sandbox'; delegates to validateFloor2Descriptor
// ===========================================================================

describe("FB-5: sandbox route + delegation to validateFloor2Descriptor", () => {
  it("custom descriptor WITHOUT flag → Floor-2 sandbox, floor2Sub='custom', flag complaint delegated", () => {
    const descriptor = {
      mode: "custom",
      reactSource: "() => <div/>",
      bindingKey: "amount",
      meta: {}, // flag missing
    } as unknown as Floor2RenderDescriptor;
    const r = classifyFloorBoundary(
      { kind: "custom_component", descriptor },
      SCHEMA,
    );
    expect(r.floor).toBe("2");
    expect(r.route).toBe("sandbox");
    expect(r.floor2Sub).toBe("custom");
    // delegated policy surfaced the missing-flag error from T-0076, not reimplemented here
    expect(r.reasons.some((x) => x.includes("CUSTOM_FLAG_MISSING"))).toBe(true);
    expect(r.reasons.some((x) => x.includes(FLOOR2_CUSTOM_FLAG_KEY))).toBe(true);
  });

  it("custom descriptor WITH flag → Floor-2 sandbox, floor2Sub='custom', no flag complaint", () => {
    const descriptor: Floor2RenderDescriptor = {
      mode: "custom",
      reactSource: "() => <div/>",
      bindingKey: "amount",
      meta: { [FLOOR2_CUSTOM_FLAG_KEY]: "true" },
    };
    const r = classifyFloorBoundary(
      { kind: "custom_component", descriptor },
      SCHEMA,
    );
    expect(r.floor).toBe("2");
    expect(r.floor2Sub).toBe("custom");
    expect(r.reasons.some((x) => x.includes("CUSTOM_FLAG_MISSING"))).toBe(false);
  });

  it("vetted descriptor → Floor-2 sandbox, floor2Sub='vetted'", () => {
    const descriptor: Floor2RenderDescriptor = {
      mode: "vetted",
      componentType: "currency_input",
      bindingKey: "amount",
    };
    const r = classifyFloorBoundary(
      { kind: "custom_component", descriptor },
      SCHEMA,
    );
    expect(r.floor).toBe("2");
    expect(r.route).toBe("sandbox");
    expect(r.floor2Sub).toBe("vetted");
  });

  it("vetted descriptor with unknown bindingKey → delegated UNKNOWN_BINDING_KEY surfaced", () => {
    const descriptor: Floor2RenderDescriptor = {
      mode: "vetted",
      componentType: "text_input",
      bindingKey: "ghost",
    };
    const r = classifyFloorBoundary({ kind: "custom_component", descriptor }, SCHEMA);
    expect(r.floor).toBe("2");
    expect(r.reasons.some((x) => x.includes("UNKNOWN_BINDING_KEY"))).toBe(true);
  });

  it("reactSource in doc tree → route='sandbox' (no descriptor → no floor2Sub invented)", () => {
    const r = classifyFloorBoundary(
      floor1Op({
        doc: {
          type: "root",
          children: [
            { type: "field", fieldKey: "amount", reactSource: "x()" } as never,
          ],
        },
      }),
      SCHEMA,
    );
    expect(r.floor).toBe("2");
    expect(r.route).toBe("sandbox");
    expect(r.floor2Sub).toBeUndefined();
  });
});

// ===========================================================================
// FB-6 — determinism + fail-closed
// ===========================================================================

describe("FB-6: determinism + fail-closed", () => {
  it("unknown kind → Floor-2 sandbox", () => {
    const r = classifyFloorBoundary(floor1Op({ kind: "totally_unknown" }), SCHEMA);
    expect(r.floor).toBe("2");
    expect(r.route).toBe("sandbox");
  });

  it("null-ish op → Floor-2 (no throw)", () => {
    const r = classifyFloorBoundary(undefined as unknown as FloorEditOp, SCHEMA);
    expect(r.floor).toBe("2");
    expect(r.route).toBe("sandbox");
  });

  it("ambiguous input (missing changedKeys/doc) on Floor-1 kind → Floor-1 (proven), but Floor-2 kind stays 2", () => {
    // relabel_field with no changedKeys, no doc — nothing violates R-2/R-3/R-4
    expect(classifyFloorBoundary({ kind: "relabel_field" }, SCHEMA).floor).toBe("1");
    expect(classifyFloorBoundary({ kind: "add_field" }, SCHEMA).floor).toBe("2");
  });

  it("repeated identical input → byte-identical result", () => {
    const op = floor1Op({ kind: "add_field", changedKeys: ["fieldKey", "type"] });
    const a = classifyFloorBoundary(op, SCHEMA);
    const b = classifyFloorBoundary(op, SCHEMA);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never throws on adversarial / malformed doc", () => {
    expect(() =>
      classifyFloorBoundary(
        {
          kind: "relabel_field",
          changedKeys: [null as unknown as string],
          doc: { children: [null as unknown as never, { type: 42 } as never] },
        },
        SCHEMA,
      ),
    ).not.toThrow();
  });
});

// ===========================================================================
// Machine-readable boundary surfaces (FB-8 / §6 gard-design — sanity)
// ===========================================================================

describe("machine-readable whitelists (AFC-5)", () => {
  it("FLOOR1_DOC_NODE_TYPES is a ReadonlySet excluding 'custom'", () => {
    expect(FLOOR1_DOC_NODE_TYPES.has("field")).toBe(true);
    expect(FLOOR1_DOC_NODE_TYPES.has("custom")).toBe(false);
  });

  it("FLOOR1_DECLARATIVE_WHITELIST excludes contract-bearing keys", () => {
    expect(FLOOR1_DECLARATIVE_WHITELIST.has("label")).toBe(true);
    expect(FLOOR1_DECLARATIVE_WHITELIST.has("fieldKey")).toBe(false);
    expect(FLOOR1_DECLARATIVE_WHITELIST.has("contract")).toBe(false);
  });
});
