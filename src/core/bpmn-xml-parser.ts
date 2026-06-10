/**
 * T-0027: BPMN XML Fail-Closed-Whitelist Tokenizer
 *
 * Security-oriented minimal XML tokenizer. Design invariant:
 *   If a byte sequence is not unambiguously recognized as a known, safe token
 *   class, it emits a `parse-error` token and stops. Whitelist, not blacklist.
 *
 * Covers all §2.2 parser-differential edge classes from the ADR:
 *   - DOCTYPE declarations → reject
 *   - Non-predefined entities → reject
 *   - Duplicate attribute names → reject
 *   - Processing instructions → reject (except the XML declaration at position 0)
 *   - Invalid UTF-8 byte sequences → reject (caller validates before passing)
 *   - Encoding declaration != utf-8/utf8 → reject
 *   - XML 1.1 → reject
 *   - Null bytes → reject
 *   - CDATA → parse content and emit as text token (scanned downstream)
 *   - Comments → stripped/discarded
 *   - Nesting depth > 200 → reject
 *   - Attribute value > 512KB → reject
 *   - Duplicate namespace prefix bindings → reject
 *   - Namespace prefixes → strip (local-name only)
 *
 * NOT a general SAX/DOM parser. Only the token types the linter needs.
 */

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export interface Attr {
  name: string; // local name (prefix stripped), entity-decoded
  value: string; // entity-decoded, numeric-ref-expanded
}

export interface OpenTagToken {
  kind: "open-tag";
  localName: string;
  attrs: Attr[];
}

export interface CloseTagToken {
  kind: "close-tag";
  localName: string;
}

export interface SelfCloseToken {
  kind: "self-close-tag";
  localName: string;
  attrs: Attr[];
}

export interface TextToken {
  kind: "text";
  value: string; // decoded; CDATA content merged in
}

export interface ParseErrorToken {
  kind: "parse-error";
  reason: string;
}

export type XmlToken =
  | OpenTagToken
  | CloseTagToken
  | SelfCloseToken
  | TextToken
  | ParseErrorToken;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DEPTH = 200;
const MAX_ATTR_VALUE_BYTES = 512 * 1024; // 512 KB

// The 5 predefined XML entities
const PREDEFINED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  quot: '"',
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize a BPMN XML string into a flat sequence of tokens.
 * Yields tokens lazily via a generator. Stops on parse-error.
 */
export function* tokenize(input: string): Generator<XmlToken> {
  // Reject null bytes (XML 1.0 §2.2 — U+0000 is illegal)
  if (input.includes("\0")) {
    yield { kind: "parse-error", reason: "null byte in XML document (illegal per XML 1.0 §2.2)" };
    return;
  }

  // Strip UTF-8 BOM if present (U+FEFF at position 0)
  let pos = 0;
  if (input.charCodeAt(0) === 0xfeff) {
    pos = 1;
  }

  let depth = 0;
  // Track namespace prefix → first-seen count (for duplicate-prefix detection)
  // We use a simple Set for declared prefixes per document scope
  const nsPrefixesSeen = new Set<string>();

  // Consume the XML declaration if present (<?xml ... ?>)
  if (input.startsWith("<?xml ", pos) || input.startsWith("<?xml?>", pos) || input.startsWith("<?XML ", pos)) {
    const declEnd = input.indexOf("?>", pos + 5);
    if (declEnd === -1) {
      yield { kind: "parse-error", reason: "unclosed XML declaration" };
      return;
    }
    const declContent = input.slice(pos + 5, declEnd);

    // Check XML version — reject 1.1
    const versionMatch = declContent.match(/version\s*=\s*["']([^"']+)["']/);
    if (versionMatch) {
      const ver = versionMatch[1];
      if (ver !== "1.0") {
        yield { kind: "parse-error", reason: `XML version "${ver}" not supported; only 1.0 is accepted` };
        return;
      }
    }

    // Check encoding — reject anything not utf-8/utf8 (case-insensitive)
    const encMatch = declContent.match(/encoding\s*=\s*["']([^"']+)["']/i);
    if (encMatch) {
      const enc = encMatch[1].toLowerCase().replace("-", "");
      if (enc !== "utf8") {
        yield { kind: "parse-error", reason: `encoding "${encMatch[1]}" not supported; BPMN deploy artifacts must be UTF-8` };
        return;
      }
    }

    pos = declEnd + 2;
  }

  while (pos < input.length) {
    if (input[pos] !== "<") {
      // Text node — collect until next '<'
      const textStart = pos;
      const nextAngle = input.indexOf("<", pos);
      const textEnd = nextAngle === -1 ? input.length : nextAngle;
      const rawText = input.slice(textStart, textEnd);
      if (rawText.length > 0) {
        const decoded = decodeEntities(rawText);
        if (decoded === null) {
          yield { kind: "parse-error", reason: `invalid or non-predefined entity reference in text content at offset ${textStart}` };
          return;
        }
        if (decoded.trim().length > 0) {
          yield { kind: "text", value: decoded };
        }
      }
      pos = textEnd;
      continue;
    }

    // We're at '<'
    if (pos + 1 >= input.length) {
      yield { kind: "parse-error", reason: "unexpected end of document after '<'" };
      return;
    }

    const next = input[pos + 1];

    // Comment: <!-- ... -->
    if (input.startsWith("<!--", pos)) {
      const commentEnd = input.indexOf("-->", pos + 4);
      if (commentEnd === -1) {
        yield { kind: "parse-error", reason: "unclosed comment" };
        return;
      }
      // Reject comments containing '--' that aren't the terminating '-->'
      const commentContent = input.slice(pos + 4, commentEnd);
      if (commentContent.includes("--")) {
        yield { kind: "parse-error", reason: "comment contains '--' which is illegal inside XML comments" };
        return;
      }
      pos = commentEnd + 3;
      continue;
    }

    // CDATA: <![CDATA[ ... ]]>
    if (input.startsWith("<![CDATA[", pos)) {
      const cdataEnd = input.indexOf("]]>", pos + 9);
      if (cdataEnd === -1) {
        yield { kind: "parse-error", reason: "unclosed CDATA section" };
        return;
      }
      const cdataContent = input.slice(pos + 9, cdataEnd);
      // Check for nested ]]> (illegal in XML)
      // Already handled — we found the first ]]> above
      if (cdataContent.length > 0) {
        yield { kind: "text", value: cdataContent };
      }
      pos = cdataEnd + 3;
      continue;
    }

    // DOCTYPE: <!DOCTYPE ... >
    if (input.startsWith("<!", pos) && input.slice(pos + 2, pos + 9).toUpperCase().startsWith("DOCTYPE")) {
      yield { kind: "parse-error", reason: "DOCTYPE declarations are not permitted in BPMN deploy artifacts (entity injection risk)" };
      return;
    }

    // Other <! constructs (e.g. <!ELEMENT, <!ATTLIST, <!ENTITY, <!NOTATION) — reject
    if (input.startsWith("<!", pos)) {
      yield { kind: "parse-error", reason: `unknown markup declaration at offset ${pos}` };
      return;
    }

    // Processing instructions: <?...?> (XML declaration was already handled above)
    if (input.startsWith("<?", pos)) {
      yield { kind: "parse-error", reason: "processing instructions are not permitted in BPMN deploy artifacts" };
      return;
    }

    // Close tag: </tagname>
    if (next === "/") {
      const closeEnd = input.indexOf(">", pos + 2);
      if (closeEnd === -1) {
        yield { kind: "parse-error", reason: "unclosed close-tag" };
        return;
      }
      const rawName = input.slice(pos + 2, closeEnd).trim();
      if (rawName.length === 0) {
        yield { kind: "parse-error", reason: "empty close-tag name" };
        return;
      }
      const localName = stripPrefix(rawName);
      if (localName.length === 0) {
        yield { kind: "parse-error", reason: `empty local name in close-tag "${rawName}"` };
        return;
      }
      depth--;
      yield { kind: "close-tag", localName };
      pos = closeEnd + 1;
      continue;
    }

    // Open tag or self-closing: <tagname ...> or <tagname .../>
    const tagResult = parseOpenTag(input, pos, nsPrefixesSeen);
    if (tagResult.error !== undefined) {
      yield { kind: "parse-error", reason: tagResult.error };
      return;
    }

    depth++;
    if (depth > MAX_DEPTH) {
      yield { kind: "parse-error", reason: `document nesting depth exceeds maximum of ${MAX_DEPTH} levels` };
      return;
    }

    if (tagResult.selfClose) {
      depth--;
      yield { kind: "self-close-tag", localName: tagResult.localName, attrs: tagResult.attrs };
    } else {
      yield { kind: "open-tag", localName: tagResult.localName, attrs: tagResult.attrs };
    }
    pos = tagResult.newPos;
  }
}

// ---------------------------------------------------------------------------
// Open-tag parser
// ---------------------------------------------------------------------------

interface OpenTagResult {
  localName: string;
  attrs: Attr[];
  selfClose: boolean;
  newPos: number;
  error?: string;
}

function parseOpenTag(
  input: string,
  start: number,
  nsPrefixesSeen: Set<string>,
): OpenTagResult {
  // start points at '<'
  let pos = start + 1;

  // Read tag name (up to whitespace, '/', or '>')
  let nameEnd = pos;
  while (nameEnd < input.length && !/[\s/>]/.test(input[nameEnd])) {
    nameEnd++;
  }
  if (nameEnd === pos) {
    return { localName: "", attrs: [], selfClose: false, newPos: pos, error: "empty tag name" };
  }

  const rawTagName = input.slice(pos, nameEnd);
  const localName = stripPrefix(rawTagName);
  if (localName.length === 0) {
    return { localName: "", attrs: [], selfClose: false, newPos: pos, error: `empty local name in tag "${rawTagName}"` };
  }

  pos = nameEnd;

  // Parse attributes
  const attrs: Attr[] = [];
  const attrNamesSeen = new Set<string>();

  while (pos < input.length) {
    // Skip whitespace
    while (pos < input.length && /\s/.test(input[pos])) pos++;

    if (pos >= input.length) {
      return { localName, attrs, selfClose: false, newPos: pos, error: "unexpected end of document inside tag" };
    }

    // End of tag
    if (input[pos] === ">") {
      return { localName, attrs, selfClose: false, newPos: pos + 1 };
    }
    if (input[pos] === "/" && input[pos + 1] === ">") {
      return { localName, attrs, selfClose: true, newPos: pos + 2 };
    }

    // Read attribute name
    let attrNameEnd = pos;
    while (attrNameEnd < input.length && !/[\s=/>]/.test(input[attrNameEnd])) {
      attrNameEnd++;
    }
    if (attrNameEnd === pos) {
      return { localName, attrs, selfClose: false, newPos: pos, error: `unexpected character '${input[pos]}' in tag <${localName}>` };
    }

    const rawAttrName = input.slice(pos, attrNameEnd);
    const attrLocalName = stripPrefix(rawAttrName);

    pos = attrNameEnd;

    // Skip whitespace before '='
    while (pos < input.length && /\s/.test(input[pos])) pos++;

    if (pos >= input.length || input[pos] !== "=") {
      return { localName, attrs, selfClose: false, newPos: pos, error: `attribute "${rawAttrName}" missing value in tag <${localName}>` };
    }
    pos++; // consume '='

    // Skip whitespace after '='
    while (pos < input.length && /\s/.test(input[pos])) pos++;

    if (pos >= input.length) {
      return { localName, attrs, selfClose: false, newPos: pos, error: "unexpected end of document after '='" };
    }

    // Read quoted attribute value
    const quoteChar = input[pos];
    if (quoteChar !== '"' && quoteChar !== "'") {
      return { localName, attrs, selfClose: false, newPos: pos, error: `unquoted attribute value in tag <${localName}> (XML requires quoted attribute values)` };
    }
    pos++; // consume opening quote

    const valueStart = pos;
    while (pos < input.length && input[pos] !== quoteChar) {
      pos++;
    }
    if (pos >= input.length) {
      return { localName, attrs, selfClose: false, newPos: pos, error: `unclosed attribute value in tag <${localName}>` };
    }

    const rawValue = input.slice(valueStart, pos);
    pos++; // consume closing quote

    // Validate attribute value size
    if (rawValue.length > MAX_ATTR_VALUE_BYTES) {
      return { localName, attrs, selfClose: false, newPos: pos, error: `attribute value in tag <${localName}> exceeds maximum size of ${MAX_ATTR_VALUE_BYTES} bytes` };
    }

    // Decode entities in attribute value
    const decodedValue = decodeEntities(rawValue);
    if (decodedValue === null) {
      return { localName, attrs, selfClose: false, newPos: pos, error: `invalid or non-predefined entity in attribute "${rawAttrName}" of tag <${localName}>` };
    }

    // Handle namespace declarations — track for duplicate detection
    if (rawAttrName.startsWith("xmlns:") || rawAttrName === "xmlns") {
      const nsPrefix = rawAttrName === "xmlns" ? "" : rawAttrName.slice(6);
      if (nsPrefixesSeen.has(nsPrefix)) {
        return { localName, attrs, selfClose: false, newPos: pos, error: `duplicate namespace prefix declaration "${rawAttrName}" (ambiguous parsing)` };
      }
      nsPrefixesSeen.add(nsPrefix);
      // Namespace declarations are intentionally not added to attrs
      // (we only work with local names)
      continue;
    }

    // Duplicate attribute check (after prefix stripping)
    if (attrNamesSeen.has(attrLocalName)) {
      return { localName, attrs, selfClose: false, newPos: pos, error: `duplicate attribute "${attrLocalName}" on element <${localName}> (parser-differential exploit path)` };
    }
    attrNamesSeen.add(attrLocalName);

    attrs.push({ name: attrLocalName, value: decodedValue });
  }

  return { localName, attrs, selfClose: false, newPos: pos, error: "unexpected end of document inside open tag" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip namespace prefix from a qualified XML name.
 * "bpmn2:serviceTask" → "serviceTask"
 * "serviceTask"       → "serviceTask"
 * ":"                 → "" (empty local name — caller rejects)
 */
function stripPrefix(qname: string): string {
  const colonIdx = qname.indexOf(":");
  if (colonIdx === -1) return qname;
  return qname.slice(colonIdx + 1);
}

/**
 * Decode XML entities and numeric character references in a string value.
 * Returns null if a non-predefined named entity is encountered (caller emits parse-error).
 *
 * Predefined entities: &lt; &gt; &amp; &apos; &quot;
 * Numeric refs: &#NNN; (decimal) and &#xHHH; (hex) — expanded and scanned.
 */
export function decodeEntities(s: string): string | null {
  if (!s.includes("&")) return s;

  let result = "";
  let pos = 0;
  while (pos < s.length) {
    const ampIdx = s.indexOf("&", pos);
    if (ampIdx === -1) {
      result += s.slice(pos);
      break;
    }
    result += s.slice(pos, ampIdx);
    pos = ampIdx + 1;

    // Find the semicolon
    const semiIdx = s.indexOf(";", pos);
    if (semiIdx === -1) {
      // Unterminated entity reference — reject
      return null;
    }

    const entityName = s.slice(pos, semiIdx);
    pos = semiIdx + 1;

    // Numeric character references
    if (entityName.startsWith("#")) {
      const numStr = entityName.slice(1);
      let codePoint: number;
      if (numStr.startsWith("x") || numStr.startsWith("X")) {
        codePoint = parseInt(numStr.slice(1), 16);
      } else {
        codePoint = parseInt(numStr, 10);
      }
      if (isNaN(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return null;
      }
      // XML 1.0: reject C0 controls except TAB, LF, CR
      if (codePoint === 0 || (codePoint < 0x20 && codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd)) {
        return null;
      }
      result += String.fromCodePoint(codePoint);
      continue;
    }

    // Named entity — only predefined 5 are allowed
    const replacement = PREDEFINED_ENTITIES[entityName];
    if (replacement === undefined) {
      return null; // non-predefined entity — reject
    }
    result += replacement;
  }

  return result;
}
