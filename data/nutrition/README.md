# USDA SR Legacy local catalog

`usda-sr-legacy.json` is a deterministic, 139-food local index of the USDA FoodData Central SR Legacy 2018-04 JSON archive. It retains the original 29 curated rows and adds 110 common grains, vegetables, fruits, legumes, meats, seafood, dairy, oils, nuts, seeds, and prepared staples. The source archive is published by USDA FoodData Central and is CC0-1.0. The top-level output records the archive SHA-256 and source URL; each food row records its exact FDC ID, original English description, explicit Chinese label and preparation description, and (for expanded rows) Chinese aliases. Raw, cooked, salted, unsalted, skin-on, skin-off, and other preparation variants remain separate rows; the importer never silently converts one preparation into another.

Regenerate from the ignored local archive:

```text
node scripts/import-usda.mjs --archive=artifacts/usda/FoodData_Central_sr_legacy_food_json_2018-04.zip --output=data/nutrition/usda-sr-legacy.json
```

The script downloads the same URL into `artifacts/usda/` when the default archive is absent. It reads the ZIP with `jszip`, selects the fixed manifest of FDC IDs (the archive contains 7,793 SR Legacy foods), and maps nutrient IDs 1008 (kcal), 1003 (protein g), 1005 (carbohydrate g), and 1004 (fat g). Missing nutrient records remain `null`; reported zero values remain zero. The 54 KB output is intended for offline baseline lookup and portion calculations, not clinical advice. USDA descriptions and preparation methods vary in specificity, and values are per 100 g of the listed food, not a serving-size estimate. The `aliases` arrays are source-independent Chinese search labels for the selected English USDA descriptions; they do not change USDA nutrient values or claim that a Chinese dish is equivalent to a listed ingredient.

`category-ranges.json` is a reproducible local fallback for a visible food category that cannot be matched to one of the exact USDA rows. It contains deliberately broad per-100-g ranges and Chinese aliases; it is never used for a completely unknown label, and it does not alter the USDA archive output.
