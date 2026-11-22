// Bundled image imports resolve to a URL string (the bundler inlines small files).
declare module "*.svg" {
  const url: string;
  export default url;
}

declare module "*.html?raw" {
  const html: string;
  export default html;
}
