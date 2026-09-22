import type {FormAnswer, FormField} from "../../opencode/types.ts";

/**
 * Question-form answer logic (pure) — visibility conditions and value
 * normalization against the server's form schema. Extracted from
 * QuestionCard so the rules are node-testable.
 */

/** Whether a field's `when` conditions pass against the current answer. */
export function fieldVisible(field: FormField, answer: FormAnswer): boolean {
    if (!field.when || field.when.length === 0) return true;
    return field.when.every((c) => {
        const v = answer[c.key];
        if (c.op === "eq") return String(v) === String(c.value);
        return String(v) !== String(c.value);
    });
}

/** An answer the server accepts for this field, or undefined (empty). */
export function normalize(field: FormField, value: unknown): string | number | boolean | string[] | undefined {
    if (field.type === "multiselect") {
        return Array.isArray(value) && value.length > 0 ? value : undefined;
    }
    if (field.type === "boolean") return typeof value === "boolean" ? value : undefined;
    if (field.type === "number" || field.type === "integer") {
        return value === "" || value == null ? undefined : Number(value);
    }
    const s = typeof value === "string" ? value.trim() : "";
    return s !== "" ? s : undefined;
}
