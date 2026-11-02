/** Wrangler bundles `*.html` imports as text modules (its default module rules). */
declare module "*.html" {
  const text: string;
  export default text;
}
