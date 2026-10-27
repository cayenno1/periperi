# Yosef Capalaran — Portfolio

A single-scroll static portfolio (HTML + CSS + JS). No build step.

## Files
- `index.html` – all content
- `styles.css` – styling
- `script.js` – animations, image loading, lightbox, copy buttons
- `uiuxProjects/`, `graphicArt/` – folders for your images

## Adding your work
1. Put UI/UX screens in `uiuxProjects/` named `donut1.png`, `donut2.png`… and `plant1.png`, `plant2.png`…
   (.png, .jpg, .jpeg or .webp; use lowercase, numbers start at 1 with no gaps; `donut-1.png` also works).
2. Put illustrations in `graphicArt/`, then list the file names in the `GRAPHIC_ART` array at the top of `script.js`.
3. Edit titles, descriptions, tags and links in `index.html`.

## Deploy
1. Create a GitHub repo and push these files (with the three image folders).
2. On [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. Framework preset: **Other**. No build command, no output directory. Click **Deploy**.
4. Your site will be live at `your-project.vercel.app` (rename it in Project Settings → Domains).
