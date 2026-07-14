/**
 * FF-A2 compile-time fixture — tsc --noEmit proves ObjectHandle is nominal.
 *
 * This file contains @ts-expect-error annotations that assert:
 *  1. A plain record object is NOT assignable to ObjectHandle.
 *  2. ObjectHandle has no `data` / `fields` / `payload` / `view` member.
 *
 * If tsc ever drops the @ts-expect-error errors (meaning a plain object IS
 * assignable), tsc will fail with "Unused '@ts-expect-error' directive" —
 * which is a gate failure on the brand invariant.
 */
import type {
  ObjectHandle,
  ResourceRef,
} from "../core/object-handle.js";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const APP_ID   = "11111111-1111-4111-1111-111111111111";

const plainRef: ResourceRef = {
  kind: "application",
  tenantId: TENANT_A,
  applicationId: APP_ID,
};

// A plain object that looks structurally like a handle (same keys) is NOT
// assignable to ObjectHandle because ObjectHandle has the nominal brand.
// @ts-expect-error — plain record object is not assignable to branded ObjectHandle
const notAHandle: ObjectHandle = {
  tenantId: TENANT_A,
  ref: plainRef,
  handleId: "fake",
};

// Suppress the "unused variable" lint — the error is the point.
void notAHandle;

// When we have a real ObjectHandle, attempting to access .data should be a
// compile error because that property does not exist on the type.
import { makeHandle } from "../core/object-handle.js";
const h: ObjectHandle = makeHandle(plainRef, TENANT_A);

// @ts-expect-error — ObjectHandle has no 'data' member
void h.data;

// @ts-expect-error — ObjectHandle has no 'fields' member
void h.fields;

// @ts-expect-error — ObjectHandle has no 'payload' member
void h.payload;

// @ts-expect-error — ObjectHandle has no 'view' member
void h.view;
