import { z } from "zod";

/**
 * Build a permissive Zod object schema from a downstream tool's JSON Schema.
 *
 * The gateway does NOT enforce types — it preserves property names so the
 * host client can display them, but accepts any value for each property.
 * The downstream server handles its own validation.
 *
 * If the input schema has no properties, returns an empty passthrough schema.
 */
export function buildPassthroughSchema(
  jsonSchema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const properties = jsonSchema?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  if (!properties || typeof properties !== "object") {
    // No known properties — accept arbitrary args
    return {};
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(
    Array.isArray(jsonSchema.required) ? jsonSchema.required : [],
  );

  for (const [key, propSchema] of Object.entries(properties)) {
    // Build a Zod type that accepts any value but carries the description
    const desc =
      typeof propSchema.description === "string"
        ? propSchema.description
        : undefined;

    let field: z.ZodTypeAny = z.any();
    if (desc) {
      field = field.describe(desc);
    }

    // Mark optional if not in required array
    if (!required.has(key)) {
      field = field.optional();
    }

    shape[key] = field;
  }

  return shape;
}
