// swagger-ui-dist ships no type declarations. We only use SwaggerUIBundle()
// (and its CSS) on the /api-docs page, so a minimal ambient module is enough —
// avoids pulling in the separate @types/swagger-ui-dist dependency.

declare module "swagger-ui-dist/swagger-ui-bundle.js" {
  const SwaggerUIBundle: (opts: Record<string, unknown>) => unknown
  export default SwaggerUIBundle
}

declare module "swagger-ui-dist/swagger-ui.css"
