import OpenAI from 'openai';
import { sanitizePrice, isValidListing, normalizeFuelType, normalizeTransmission } from '../utils/normalizer.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Raw data from scrapers before validation.
 */
export interface RawVehicleData {
  portalId: string;
  sourcePortal: string;
  brand: string;
  model: string;
  version?: string | null;
  year: number;
  mileageKm: number;
  price: number;
  powerHp?: number | null;
  fuelType?: string | null;
  transmission?: string | null;
  sellerType?: string | null;
  countryOfOrigin: string;
  originalUrl: string;
}

/**
 * Validated and enriched data ready to be saved to the DB.
 */
export interface ValidatedVehicleData {
  portalId: string;
  sourcePortal: string;
  brand: string;
  model: string;
  version: string | null;
  year: number;
  mileageKm: number;
  price: number;
  powerHp: number | null;
  fuelType: string | null;
  transmission: string | null;
  sellerType: string | null;
  countryOfOrigin: string;
  originalUrl: string;
}

// Simple cache to avoid repetitive GPT calls for the same make+model
const aiCache = new Map<string, { transmission?: string; fuelType?: string; powerHp?: number }>();

/**
 * Main data quality pipeline.
 * Receives raw data from the scraper and returns clean data or null if discarded.
 */
export async function validateAndEnrich(raw: RawVehicleData): Promise<ValidatedVehicleData | null> {
  // ── STEP 1: Mandatory validation of brand and model ──
  if (!isValidListing(raw.brand, raw.model)) {
    console.log(`🚫 [Pipeline] Discarded: Invalid brand="${raw.brand}" model="${raw.model}" (${raw.portalId})`);
    return null;
  }

  // ── STEP 2: Price sanitization ──
  const sanitizedPrice = sanitizePrice(raw.price);
  if (sanitizedPrice === null) {
    console.log(`🚫 [Pipeline] Discarded: Invalid price=${raw.price} (${raw.portalId})`);
    return null;
  }

  if (sanitizedPrice !== raw.price) {
    console.log(`💰 [Pipeline] Price corrected: ${raw.price} → €${sanitizedPrice} (${raw.portalId})`);
  }

  // ── STEP 3: Normalize transmission and fuelType if they already have a known value ──
  let transmission = raw.transmission ? normalizeTransmission(raw.transmission) : 'Unknown';
  let fuelType = raw.fuelType ? normalizeFuelType(raw.fuelType) : 'Unknown';
  let powerHp = raw.powerHp && raw.powerHp > 0 ? raw.powerHp : 0;

  // ── STEP 4: Enrichment with GPT-4o-mini if data is missing ──
  // Fuel is NEVER inferred by GPT (hallucinates LPG/Petrol). Leave null/pending.
  const needsTransmission = transmission === 'Unknown';
  const needsFuelType = false;
  const needsPowerHp = powerHp === 0;

  if (needsTransmission || needsPowerHp) {
    const cacheKey = `${raw.brand.toLowerCase()}-${raw.model.toLowerCase()}-${raw.version?.toLowerCase() || ''}-${raw.year}`;
    const cached = aiCache.get(cacheKey);

    if (cached) {
      if (needsTransmission && cached.transmission) {
        transmission = cached.transmission;
        console.log(`🧠 [Pipeline/Cache] Inferred transmission: ${transmission} (${raw.brand} ${raw.model})`);
      }
      if (needsPowerHp && cached.powerHp) {
        powerHp = cached.powerHp;
        console.log(`🧠 [Pipeline/Cache] Inferred power (HP): ${powerHp} (${raw.brand} ${raw.model})`);
      }
    } else {
      const aiResult = await inferMissingDataWithAI(
        raw.brand,
        raw.model,
        raw.version || '',
        raw.year,
        needsTransmission,
        needsFuelType,
        needsPowerHp
      );

      if (aiResult) {
        if (needsTransmission && aiResult.transmission) {
          transmission = aiResult.transmission;
          console.log(`🤖 [Pipeline/AI] Inferred transmission: ${transmission} (${raw.brand} ${raw.model})`);
        }
        if (needsPowerHp && aiResult.powerHp) {
          powerHp = aiResult.powerHp;
          console.log(`🤖 [Pipeline/AI] Inferred power (HP): ${powerHp} (${raw.brand} ${raw.model})`);
        }

        const cacheEntry: { transmission?: string; fuelType?: string; powerHp?: number } = {};
        if (aiResult.transmission) cacheEntry.transmission = aiResult.transmission;
        if (aiResult.powerHp) cacheEntry.powerHp = aiResult.powerHp;
        aiCache.set(cacheKey, cacheEntry);
      }
    }
  }

  // ── STEP 5: Return clean data ──
  return {
    portalId: raw.portalId,
    sourcePortal: raw.sourcePortal,
    brand: raw.brand.trim(),
    model: raw.model.trim(),
    version: raw.version?.trim() || null,
    year: raw.year,
    mileageKm: raw.mileageKm,
    price: sanitizedPrice,
    powerHp: powerHp > 0 ? powerHp : null,
    fuelType: fuelType !== 'Unknown' ? fuelType : null,
    transmission: transmission !== 'Unknown' ? transmission : null,
    sellerType: raw.sellerType || null,
    countryOfOrigin: raw.countryOfOrigin,
    originalUrl: normalizeOriginalUrlInline(raw.originalUrl)
  };
}

function normalizeOriginalUrlInline(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    for (const k of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'msclkid'
    ]) {
      u.searchParams.delete(k);
    }
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}

/**
 * Calls GPT-4o-mini to infer missing vehicle data based on brand, model, and version.
 */
async function inferMissingDataWithAI(
  brand: string,
  model: string,
  version: string,
  year: number,
  needsTransmission: boolean,
  needsFuelType: boolean,
  needsPowerHp: boolean
): Promise<{ transmission?: string; fuelType?: string; powerHp?: number } | null> {
  try {
    const fieldsNeeded: string[] = [];
    if (needsTransmission) fieldsNeeded.push('"transmission": "Manual" or "Automatic"');
    if (needsFuelType) fieldsNeeded.push('"fuelType": "Diesel", "Petrol", "Hybrid", "Electric", or "LPG"');
    if (needsPowerHp) fieldsNeeded.push('"powerHp": approximate horsepower as an integer number');

    const prompt = `You are an automotive expert. Given a car: ${brand} ${model} ${version} (${year}), provide the most likely values for the following missing fields. Respond ONLY with a valid JSON object, no other text.

Fields needed:
${fieldsNeeded.join('\n')}

Example response: {"transmission": "Automatic", "fuelType": "Diesel", "powerHp": 150}
Only include the fields that were asked for.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 100,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    // Extract JSON from the response (sometimes GPT wraps in ```json ... ```)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    
    const result: { transmission?: string; fuelType?: string; powerHp?: number } = {};

    if (parsed.transmission) {
      const normalized = normalizeTransmission(parsed.transmission);
      if (normalized !== 'Unknown') result.transmission = normalized;
    }

    if (parsed.fuelType) {
      const normalized = normalizeFuelType(parsed.fuelType);
      if (normalized !== 'Unknown') result.fuelType = normalized;
    }

    if (parsed.powerHp && typeof parsed.powerHp === 'number' && parsed.powerHp > 0) {
      result.powerHp = Math.round(parsed.powerHp);
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (error: any) {
    console.warn(`⚠️ [Pipeline/AI] Error calling GPT-4o-mini for ${brand} ${model}: ${error.message}`);
    return null;
  }
}

/**
 * Clears the AI cache (useful for tests or to force new inferences).
 */
export function clearAICache(): void {
  aiCache.clear();
}
