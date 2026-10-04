// Bundled image imports resolve to a URL string (the bundler inlines small files).
declare module "*.svg" {
  const url: string;
  export default url;
}
