# App shell layout (authenticated dashboard)

Structural contract for the mobile app surface: who owns the viewport height,
where the bottom nav lives, and the rules that keep it working.

Applies to every authenticated screen: Home, Wallet, Swap, History, Account.
They all render inside the same shell, so a change here changes all five.

Related: `tasks/LAYOUT.md` holds the slides model (chips, `?s=` deep links).
This doc holds only the height and positioning contract.

---

## The chain

```text
body.page-shell            flex column, min-h 100dvh
  main (AppChrome)         app routes: px-4, vertical padding starts at md
    div.app-shell          flex column, min-h 100dvh below md
      div.fade-up          flex-1 -- entrance animation lives HERE
        AppPage            flex-1 flex column
          AppTopBar        sticky top-0
          chips / status strip
          AppSection       grow on mobile, absorbs the leftover space
      AppBottomNav         fixed bottom-0, OUTSIDE the animated wrapper
```

**The shell owns the height, not the panels.** A panel is handed the space that
is actually left and grows into it. It never computes that space itself.

Header is `sticky`, not `fixed`, on purpose: it stays in flow, so it
participates in the column height and needs no compensating top offset.

---

## Rules that must not be broken

### 1. No transform, filter, backdrop-filter or will-change on any ancestor of `AppBottomNav`

Any of those properties makes the element a **containing block for
`position: fixed` descendants**. The nav then resolves against that ancestor
instead of the viewport, silently becoming absolute and scrolling away, while
the CSS still reads `position: fixed` and review still passes.

This is not hypothetical. It shipped. `.fade-up` sat on `.app-shell` animating
`transform`, and `animation-fill-mode: both` means the final `translateY(0)`
persists after the animation ends. Measured on an 844px viewport, the nav's
rect was `bottom: 2116` -- the bottom of the document.

That is why `fade-up` is on an inner wrapper. **If you add a page-level
animation, put it inside that wrapper, never on an ancestor of the nav.**

Symptom to watch for: the nav sits wherever content ends rather than at the
bottom of the screen.

### 2. Panels never set their own viewport-relative min-height

A `min-height: calc(100dvh - <constant>)` floor on a panel cannot know what sits
above it, and what sits above it varies per page and per state: Home has a
status strip and conditional alert banners, History has no chips at all. The
constant over-reserves, pushes the card past the fold, and produces exactly the
dead void it was added to remove.

Use `grow` (flex-grow with `basis: auto`) so the panel absorbs the real
leftover. `basis: auto` matters: it means a panel is never squashed below its
content, and sibling panels on one slide split the surplus rather than being
forced to equal heights.

Growth is mobile-only (`md:grow-0`). From md up the bottom nav is hidden and a
plain min-height reads better than cards stretched down a tall desktop viewport.

### 3. Every bottom offset derives from one token

Defined in `web/app/globals.css`:

| Token | Meaning |
|---|---|
| `--app-nav-row` | Nav row height. Declared, and the row is pinned to it, so it is true by construction rather than estimated. |
| `--app-nav-overhang` | How far the Swap pill rides above the bar (`-mt-4`). |
| `--app-nav-h` | `--app-nav-row` + `env(safe-area-inset-bottom)`. |
| `--app-nav-clearance` | `--app-nav-h` + overhang + deliberate breathing room. Content padding uses this. |

**Do not hardcode a `pb-*` to clear the nav.** Three unrelated hardcoded numbers
(a `pb-24`, a `13.5rem` panel floor, and the nav's own padding) are what let the
last list item hide under the bar.

### 4. The safe-area inset is applied in exactly one place

`.app-bottom-nav` in `globals.css`, and nowhere else. It was previously declared
there *and* as `pb-[env(safe-area-inset-bottom)]` on the inner nav row, giving
roughly 68px instead of 34px on gesture-nav phones.

### 5. `dvh`, never `vh`

Anything that has to survive mobile browser chrome appearing and disappearing
uses `dvh`. `100vh` is the classic naive fix that clips the nav or leaves a gap
on phones.

---

## Verifying a change here

Geometry must be **measured, not read**. Rule 1 is invisible to CSS inspection.

Headless Chrome at 390x844, with and without an emulated safe-area inset
(`Emulation.setSafeAreaInsetsOverride`), asserting:

- the nav's `getBoundingClientRect().bottom` equals `window.innerHeight` at
  every scroll position, and its `top` does not change while scrolling
- a short tab does not scroll and leaves no gap below the card
- the last item of a long tab clears the nav's top edge
- the sticky header's `top` is 0 once scrolled
- the nav row's computed height equals `--app-nav-row`, and the inset appears
  on the nav but not on the row

Then confirm on a real device. An emulator cannot reproduce iOS Safari's URL bar
collapsing, which is the exact case `dvh` exists for: load a long tab, scroll
hard, and watch whether the nav holds or jumps as the chrome hides.
