I want a new pragma: `@box <style-name> {` / `@}`.

Example:

```md
@box prompt-assistant {
Il y a bien une jusrisprudence du ... qui dit ...
@}
```

It will encapsulate the content in a box that has the style `<style-name>`, described in the style file.

This style must, at least, define:

- background color
- text color (if not defined, w take black or white depending on which one is more readable on this background)
- border
- border-radius
- shadow
