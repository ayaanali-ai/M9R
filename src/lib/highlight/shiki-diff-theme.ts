import type { ThemeRegistrationRaw } from "shiki";

/**
 * Custom monochrome-plus theme for the Files panel's diff view (Option A
 * step 12, phase 2). Built directly from the warm-grey token ramp in
 * globals.css:369-410 -- Shiki themes can't read CSS custom properties, so
 * these hex values are a deliberate, intentional duplicate of that ramp.
 * If the ramp in globals.css ever changes, update these to match.
 *
 * Two or three tiers of the same warm grey, differentiated by weight, not
 * hue -- the whole point is that this looks expensive next to a default
 * rainbow theme (github-dark, etc.) and never fights the +/- diff line
 * coloring already applied as a background in files-panel.tsx.
 */
export const olDiffTheme: ThemeRegistrationRaw = {
  name: "ol-diff",
  type: "dark",
  colors: {
    "editor.background": "#00000000",
    "editor.foreground": "#f2efe9",
  },
  settings: [
    {
      settings: { foreground: "#f2efe9" },
    },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#48453f" },
    },
    {
      scope: [
        "punctuation",
        "meta.brace",
        "meta.delimiter",
        "keyword.operator",
        "storage.type.function.arrow",
      ],
      settings: { foreground: "#726c60" },
    },
    {
      scope: ["variable", "variable.other", "variable.parameter", "support.variable"],
      settings: { foreground: "#a39d90" },
    },
    {
      scope: ["entity.name.tag", "entity.other.attribute-name", "support.type.property-name"],
      settings: { foreground: "#a39d90" },
    },
    {
      scope: [
        "keyword",
        "keyword.control",
        "storage",
        "storage.type",
        "storage.modifier",
        "constant.language",
      ],
      settings: { foreground: "#f2efe9", fontStyle: "bold" },
    },
    {
      scope: ["string", "string.quoted", "constant.character", "constant.numeric"],
      settings: { foreground: "#f2efe9", fontStyle: "bold" },
    },
    {
      scope: ["entity.name.function", "support.function"],
      settings: { foreground: "#f2efe9" },
    },
    {
      scope: ["entity.name.class", "entity.name.type", "support.class", "support.type"],
      settings: { foreground: "#a39d90", fontStyle: "bold" },
    },
    {
      scope: ["invalid", "invalid.illegal"],
      settings: { foreground: "#d2504b" },
    },
  ],
};
