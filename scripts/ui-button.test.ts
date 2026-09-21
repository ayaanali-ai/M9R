import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Button, IconButton, buttonClassName, type ButtonProps, type IconButtonProps } from "../src/components/ui/button.tsx";

test("Button renders the shared .ol-btn classes and defaults to type=button", () => {
  const props: ButtonProps = { variant: "primary", size: "sm", children: "Save" };
  const html = renderToStaticMarkup(createElement(Button, props));
  assert.match(html, /class="ol-btn ol-btn--primary ol-btn--sm"/);
  assert.match(html, /type="button"/);
});

test("loading disables activation, announces busy and shows the spinner", () => {
  const props: ButtonProps = { loading: true, children: "Send" };
  const html = renderToStaticMarkup(createElement(Button, props));
  assert.match(html, /disabled/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /ol-btn__spinner/);
});

test("IconButton always carries an accessible name and a tooltip", () => {
  const props: IconButtonProps = { label: "Close panel", children: "x" };
  const html = renderToStaticMarkup(createElement(IconButton, props));
  assert.match(html, /aria-label="Close panel"/);
  assert.match(html, /title="Close panel"/);
  assert.match(html, /ol-btn--icon/);
});

test("buttonClassName drops empty parts", () => {
  assert.equal(buttonClassName("ghost", "md"), "ol-btn ol-btn--ghost");
});
