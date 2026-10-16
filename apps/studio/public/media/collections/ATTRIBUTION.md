# Collections page photography

Downloaded and inspected on 2026-10-15. These photographs decorate page headings only. They are not user productions, indexed assets, template output examples, or evidence of review results. The UI loads only the local WebP files listed below.

All four source photo pages identify the work as a free photo under the [Unsplash License](https://unsplash.com/license), not Unsplash+. The license permits downloading, copying, modifying and using these photos, including commercial use, without asking permission; attribution is appreciated. It does not allow selling unmodified photos or compiling them into a competing image service. Photograph credit does not imply endorsement by the photographer or any depicted person or brand.

| Local file | Photographer | Source photo | Page use |
| --- | --- | --- | --- |
| `editing-desk.webp` | [Jakub Żerdzicki](https://unsplash.com/@jakubzerdzicki) | [A desk with computer monitors and photography equipment](https://unsplash.com/photos/a-desk-with-computer-monitors-and-photography-equipment-aSoQQLyPe1U) | Production records heading |
| `film-archive.webp` | [Annie Spratt](https://unsplash.com/@anniespratt) | [Film negative](https://unsplash.com/photos/film-negative-0XYXwbikhQo) | Asset library heading |
| `story-notebook.webp` | [Kawê Rodrigues](https://unsplash.com/@kawerodriguess) | [A desk with a camera, notebook, pen and pencils](https://unsplash.com/photos/a-desk-with-a-camera-notebook-pen-and-pencils-UnG6YtMuPeo) | Template reference heading |
| `film-review.webp` | [Hossein Nasr](https://unsplash.com/@nasrphotos) | [Person examining film negatives with a loupe](https://unsplash.com/photos/person-examining-film-negatives-with-a-loupe-pneiKD4wbZI) | Production retrospective heading |

Source CDN paths, verified against each source page's image metadata:

- `editing-desk.webp`: `https://images.unsplash.com/photo-1777019075773-a231fa4e4534?fm=jpg&fit=max&w=1200&q=72`
- `film-archive.webp`: `https://images.unsplash.com/photo-1562079551-9a3a2b562022?fm=jpg&fit=max&w=1200&q=72`
- `story-notebook.webp`: `https://images.unsplash.com/photo-1675453987277-c7a5834daf14?fm=jpg&fit=max&w=1200&q=72`
- `film-review.webp`: `https://images.unsplash.com/photo-1762028892198-3dd53a039249?fm=jpg&fit=max&w=1200&q=72`

Processing: the downloaded JPEGs were decoded locally using Pillow and re-encoded as WebP (quality 78, method 6), keeping their full pixel dimensions and composition. Responsive heading images use CSS cropping; actual production and asset media continue to use `object-fit: contain`. Original downloaded data lives in the task's isolated `.local/ui-ux/downloads-collections/` directory and is not shipped.
