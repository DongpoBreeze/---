# Nutrition Estimation Integration

Date: 2026-10-17. Scope: dish recognition, local per-100-g nutrition references, user-entered quantities, portable analysis history, and real-photo diagnostics. Health records and original media remain local and are not rewritten by validation.

## Analysis contract

The model returns dish-recognition facts only: `foodName`, components, ranked candidates, preparation/cooking observations, optional image regions and evidence, confidence, uncertainty, assumptions, and advice. It must not return photo-derived weight, portion size, consumed fraction, nutrient totals, or nutrition-database provenance. The server rejects those fields and validates the complete response before accepting a stage.

Each component retains its label, candidates, identity uncertainty, evidence, category, and image region. A confirmed food identity remains eligible for a local reference when only quantity or cooking details are uncertain; an unresolved identity conflict prevents exact food matching. Older analyses remain readable, including their legacy `grams`, `quantitySource`, `consumedFraction`, and estimate-scope fields, but those legacy photo estimates are never migrated into user-entered quantities.

## Local reference and quantity calculation

Every recognized dish is matched against the bundled USDA SR Legacy index or a local broad category range. The result can show per-100-g kcal, protein, carbohydrate, and fat references. A household unit is offered only when the local catalog has an explicit gram conversion, such as half a bowl of cooked rice at approximately 100 g; otherwise the user enters grams.

New analyses start with quantity blank. For each dish, a user may enter grams or the displayed household-unit count. The local calculator applies that quantity to the local nutrient reference. It shows the subtotal for counted dishes and names dishes omitted for missing quantity or unavailable nutrition. No quantity means no intake contribution. A partial subtotal is marked incomplete in the meal analysis and daily summary. Nutrients absent from a reference remain unknown instead of being invented.

The bundled index is `data/nutrition/usda-sr-legacy.json`: 139 selected, archive-backed foods, retaining the original 29 identities and adding 110 common ingredients with Chinese aliases and explicit preparation labels. Values come from USDA FoodData Central SR Legacy 2018-04 (CC0-1.0); the data README documents reproducible archive extraction. Broad fallback ranges are maintained in `data/nutrition/category-ranges.json` and are labeled approximate.

## Request flow and reliability

The adaptive flow makes one whole-photo request, then may make one targeted crop review with at most four crops when confidence, duplicates, candidate ambiguity, or identity conflicts warrant it. A final merge is sent only when review conflicts materially with the first result. Maximum: three requests per meal; no automatic retries. Each stage has a 180-second timeout and can be cancelled. A later review timeout or invalid response does not discard an already validated first-stage result.

Only a complete provider completion event followed by schema and business validation is accepted. HTTP 200, partial stream text, `[DONE]`, or an ended stream is not success. `{kind,data}` wrappers are accepted only when the kind matches the request and the wrapped value validates. Native/app clients create local crops. Direct gateway callers without an image-crop callback may skip targeted review; diagnostics must not claim that absent crops were reviewed.

## Saving, correction, and display

The app retains the original photo separately from its normalized analysis copy. Analysis versions and input revisions remain separate. A quantity correction creates a new local analysis version and does not modify the original recognition or photo. Exports preserve old analyses and include new `userQuantity`, household conversion, coverage, and nutrition-source fields; import remains backward-compatible.

The result view first shows recognized dishes and confidence. Per-100-g references and any reliable household conversion are available in the estimate basis. User-entered quantities produce either a complete result or a clearly labeled subtotal. Supporting candidates, evidence, uncertainty, and omitted dishes remain available in the estimate-basis details.

## Validation status

The automated checks cover recognition-only schema rejection, wrappers, streaming completion, timeout/cancellation behavior, adaptive review and first-result retention, per-100-g USDA/category references, household conversion, gram/unit entry, partial totals, daily-summary incompleteness, and legacy backup compatibility. Current command results are recorded in `docs/development.md`.

The 50-meal truth-set template and offline evaluator are available, but the template contains no labeled meals. Product recognition accuracy and nutrition accuracy therefore remain pending. Real-photo protocol completion can validate transport and schema behavior only; without human-confirmed dish identities and user-entered amounts, it cannot establish nutritional accuracy.
