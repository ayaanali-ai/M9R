# M9R homepage: reference sites, v2 (2026-09-20)

Purpose: a fixed set of references to hand to the designer (Astra) so the homepage can be built without spending more of our test budget. **v2 replaces the first list.** It is built from the owner's answers, not from a generic "best sites" roundup.

## Owner's brief (answers given 2026-09-20)
- **Mood:** dreamy daylight + surreal and playful + cinematic and epic.
- **Experience:** a scroll story (the page advances as you scroll, guided).
- **Density:** rich but organised (many details, clear sections, strong hierarchy). "Extremely visually dense" was the earlier wording.
- **Product proof:** visual metaphor only (sky, clouds, messages flying), with the product explained in words. No fake screenshots.
- **Brand:** the new logo is an orange, soft clay-like embossed head profile with a maze-like swirl, floating in a bright blue cloudy sky. Daylight and warm, not the dark "AI tool" look.
- **The one idea to express:** your agents stay where they are, and M9R is the air between them. Sessions are clouds or rooms; messages travel between them as you scroll.

## How the references were chosen
From curated 2026 write-ups and galleries (Utsubo, scrollytelling.ai, the Awwwards storytelling collection, Awwwards Sites of the Day), filtered for the brief above. **I have not visited each site in a browser;** the notes come from those write-ups and from an HTTP check (all returned 200; Cartier and Humain block scripts but are normal sites). The designer must open every one before copying anything.

## Candidates, grouped by what they are for

### A. The world you scroll through (the backbone)
| Site | URL | Why it fits |
|---|---|---|
| Explore Primland | https://explore.ownprimland.com | Aerial flythrough with fog and atmospheric depth. Our sky, in a real place. |
| Admire & Amaze (De Bijenkorf) | https://www.awwwards.com/sites/de-bijenkorf-magical-forest | You scroll through a magical world led by a glowing bee. Surreal, cinematic, one guide character. Our "message" could be the guide. |
| IVRESS | https://brand.ivress.co.jp | Scroll-driven cycle of looping 3D scenes with continuous transitions. Cinematic and surreal pacing. |
| Universe to You | https://www.scrollytelling.ai/universe-to-you/ | Zooms from the observable universe down to the reader. A strong shape for "from any app, to you". |

### B. Soft, dreamy, physical
| Site | URL | Why it fits |
|---|---|---|
| Oryzo | https://oryzo.ai | One physical hero object with inertia and depth-of-field camera. Our clay head as the single object. |
| Where Worlds Take Shape | https://paodao.fr | Soft low-poly landscape you walk through. Nature, calm. (Exploration, not scroll, so borrow the feel, not the mechanic.) |
| Frequency Breathwork | https://frequencybreathwork.com | Slow, soft-blur, dreamy pacing. |
| Lunarwheel | https://lunarwheel.it | A 3D WebGL journey through a lunar landscape. Surreal, epic scale. |

### C. Playful and surreal
| Site | URL | Why it fits |
|---|---|---|
| Ponpon Mania | https://ponpon-mania.com | Illustrated characters with physics, structured like an album. Agents as characters. |
| Why Zero | https://why.zero.university | 3D parallax with gamified reveals and a progress counter. Playful reward for scrolling. |
| Poly | https://poly.app | Full-screen WebGL with morphing 3D shapes and textures. Surreal materials. |
| Santioni Spirits | https://santionispirits.com | Ink-comic panels advanced by a hold gesture instead of scroll. A memorable interaction to borrow one moment from. |

### D. Organised density (keeping "dense" from becoming a mess)
| Site | URL | Why it fits |
|---|---|---|
| Cartier Watches & Wonders | https://www.cartier.com/watchesandwonders | Separate 3D rooms you scroll between. Each live session as its own room. |
| Igloo | https://igloo.inc | Scroll-driven navigation that feels like moving through a structure. |
| Sleep Well Creative | https://sleep-well-creatives.com | An illustrated 3D story whose scenes advance with scroll. |

### E. Type (choose one, owner)
Kinetic and loud: Mat Voyce https://matvoyce.tv or Obys. Calm editorial: By-Kin https://by-kin.com. My lean is By-Kin because the brand is warm and soft.

## Rules for the designer
1. No generic AI-SaaS look: no purple gradient on white, no stock illustrations, no default component-library feel.
2. One display typeface and one text typeface at most, with real hierarchy.
3. Motion means something (a message travelling, a session lighting up), not decoration.
4. Say what M9R does in the first screen, in words. The visual is a metaphor; no fake screenshots or invented metrics.
5. Must work at about 400 px wide and fall back gracefully when WebGL is unavailable or slow. Smooth motion on a mid-range phone.
6. Cost stays at zero: static assets on the existing Cloudflare Worker, libraries from an approved CDN or bundled, no paid services.
7. Keep sign-in and workspace-invite entry points working during the swap.
8. The sentence to express: M9R makes actual live intelligences reachable to each other, across providers, people and machines, without forcing them into a new runtime or workspace. Approved lines: "Your agents stay where they are. M9R makes them present everywhere." and "You shouldn't need to open M9R to use M9R."

## Stack that fits the repo
Next.js App Router page; Three.js or a lighter canvas for the sky scene; GSAP for scroll timelines. Choose the lightest option that delivers the scene and add a static fallback.

## LOCKED (owner popup answers, 2026-09-20)
Owner said the experience should be **like NebulaAI and TypeSafe AI**: one strong concept-driven visual world, distinctive, not a template. Second-round picks:

- **Big hero opening:** Explore Primland (the dreamy aerial sky and atmosphere, https://explore.ownprimland.com) **plus** Oryzo (one physical hero object with weight and depth, https://oryzo.ai). Our version: the clay head floating in the daylight sky.
- **Dense sections below the hero:** TypeSafe (https://typesafe.ai: scattered small OS-style windows, dithered halftone textures, playful widgets, tight bold headlines) **plus** Cartier Watches & Wonders (https://www.cartier.com/watchesandwonders: separate rooms you scroll between).
- **Playful and surreal list:** none chosen. Do not add the Ponpon Mania, Why Zero, Poly or Santioni ideas.
- **Anchors the owner already likes:** Nebula (the dotted particle sphere with orbit rings, near-black, minimal, https://nebula.gg) and TypeSafe.
- **Type and pacing:** owner had no preference, so the decision is ours. Recommendation: one tight, bold grotesque display face for headlines (the TypeSafe pattern) plus one monospace face for window labels and small UI text; calm, weighted scroll (By-Kin's smoothness, not its look). Two typefaces total.

## Direction in one paragraph (for the designer)
A big daylight hero: the orange clay head floating in a bright, atmospheric sky (Primland's depth and fog, Oryzo's physical presence). Scroll down and the sky opens into dense, organised sections built as a scatter of small OS-style windows and rooms (TypeSafe's windows and dithered texture, Cartier's separate rooms), each window or room standing for a live agent session, with small messages travelling between them as you scroll. The product is explained in words beside the metaphor; there are no screenshots. Mood: dreamy daylight, surreal and cinematic touches. Experience: scroll story. Density: big hero, then dense.

## Status
Locked by the owner. Next: hand to the designer (Astra). Open items for the designer: the exact colour palette from the logo, the WebGL versus canvas choice, and the mobile fallback.
