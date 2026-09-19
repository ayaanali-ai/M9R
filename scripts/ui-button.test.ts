import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Button, IconButton, buttonClassName } from "../src/components/ui/button.tsx";

test("Button renders the shared .ol-btn classes and defaults to type=button", () => {
  const html = renderToStaticMarkup(createElement(Button, { variant: "primary", size: "sm" }, "Save"));
  assert.match(html, /class="ol-btn ol-btn--primary ol-btn--sm"/);
  assert.match(html, /type="button"/);
});

test("loading disables activation, announces busy and shows the spinner", () => {
  const html = renderToStaticMarkup(createElement(Button, { loading: true }, "Send"));
  assert.match(html, /disabled/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /ol-btn__spinner/);
});

test("IconButton always carries an accessible name and a tooltip", () => {
  const html = renderToStaticMarkup(createElement(IconButton, { label: "Close panel" }, "x"));
  assert.match(html, /aria-label="Close panel"/);
  assert.match(html, /title="Close panel"/);
  assert.match(html, /ol-btn--icon/);
});

test("buttonClassName drops empty parts", () => {
  assert.equal(buttonClassName("ghost", "md"), "ol-btn ol-btn--ghost");
});
