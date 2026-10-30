// Pages Functions bundle an imported .html file as its text (functions/admin.ts).
declare module "*.html" {
  const text: string;
  export default text;
}
