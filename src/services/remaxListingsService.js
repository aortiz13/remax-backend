/**
 * RE/MAX Listings Service — projection layer.
 * Pulls listings from the public RE/MAX Azure Search API and shapes them
 * into a flat, frontend/DB-friendly form. Also groups multiple listing
 * versions of the same physical property (by ListingReference / ROL).
 *
 * Used by:
 *   - routes/sync.js              (manual admin sync from /admin/import)
 *   - services/propertySyncService.js (cron worker + manual sync)
 */

const SEARCH_URL = 'https://www.remax.cl/search/listing-search/docs/search';
const PAGE_SIZE = 200;
const MAX_LISTINGS_PER_AGENT = 2000;

// ListingStatusUID → label / activity flags (verified against facet data on 13k+ CL listings)
export const STATUS_MAP = {
    160: { label: 'Activa',     active: true,  closed: false },
    161: { label: 'Retirada',   active: false, closed: false }, // Expirada sin relistar
    162: { label: 'Retirada',   active: false, closed: false },
    164: { label: 'Retirada',   active: false, closed: false },
    166: { label: 'Retirada',   active: false, closed: false },
    167: { label: 'Vendida',    active: false, closed: true  },
    168: { label: 'Pausada',    active: false, closed: false },
    169: { label: 'Concretada', active: false, closed: true  }, // Cerrada (arriendo/promesa)
    4812: { label: 'Retirada',  active: false, closed: false },
};

export const TRANSACTION_TYPE_MAP = {
    260: 'venta',
    261: 'arriendo',
};

export const PROPERTY_TYPE_MAP = {
    194: 'Departamento', 202: 'Casa', 196: 'Casa',
    13:  'Comercial',    211: 'Oficina', 18: 'Terreno', 19: 'Terreno',
    197: 'Parcela',      220: 'Bodega',  224: 'Estacionamiento', 230: 'Industrial',
    3202: 'Departamento', 3211: 'Oficina', 3212: 'Comercial', 3199: 'Comercial',
    3320: 'Casa', 3321: 'Departamento', 3323: 'Comercial', 3499: 'Terreno',
    2901: 'Parcela', 2806: 'Casa', 2785: 'Terreno', 2778: 'Terreno',
    1003: 'Industrial', 1009: 'Industrial', 1114: 'Bodega', 1116: 'Estacionamiento',
    799: 'Comercial', 5292: 'Comercial', 5553: 'Industrial',
};

export const URL_TYPE_MAP = {
    oficina: 'Oficina', departamento: 'Departamento', casa: 'Casa',
    terreno: 'Terreno', comercial: 'Comercial', bodega: 'Bodega',
    estacionamiento: 'Estacionamiento', parcela: 'Parcela',
    industrial: 'Industrial', sitio: 'Terreno', agricola: 'Parcela',
};

// Helpers
const getVal = (obj, key) => {
    if (!obj) return undefined;
    const foundKey = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
    return foundKey ? obj[foundKey] : undefined;
};

const tsToMs = (v) => {
    if (!v) return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e11 ? n * 1000 : n;
};

const tsToIso = (v) => {
    const ms = tsToMs(v);
    if (ms === null) return null;
    try { return new Date(ms).toISOString(); } catch { return null; }
};

const toNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const pickDescription = (descArr, typeUID) => {
    if (!Array.isArray(descArr) || !descArr.length) return '';
    let candidates = descArr.filter(d => d?.ISOLanguageCode === 'es' || d?.LanguageCode?.startsWith?.('es'));
    if (!candidates.length) candidates = descArr;
    if (typeUID) {
        const m = candidates.find(d => String(d.DescriptionTypeUID) === typeUID);
        if (m?.Description) return m.Description;
    }
    return candidates[0]?.Description || '';
};

const buildImageUrl = (fileName, countryId) =>
    `https://remax.azureedge.net/userimages/${countryId || 1028}/LargeWM/${fileName}`;

const detectPropertyType = (sourceUrl, propertyTypeUID, title, desc) => {
    if (sourceUrl) {
        const parts = sourceUrl.toLowerCase().split('/');
        const idx = parts.indexOf('propiedades');
        if (idx !== -1 && parts.length > idx + 1) {
            const seg = parts[idx + 1];
            if (URL_TYPE_MAP[seg]) return URL_TYPE_MAP[seg];
        }
    }
    if (propertyTypeUID && PROPERTY_TYPE_MAP[propertyTypeUID]) return PROPERTY_TYPE_MAP[propertyTypeUID];
    const combined = `${title} ${desc}`.toUpperCase();
    if (combined.includes('OFICINA')) return 'Oficina';
    if (combined.includes('LOCAL COMERCIAL') || combined.includes('COMERCIAL')) return 'Comercial';
    if (combined.includes('TERRENO') || combined.includes('SITIO')) return 'Terreno';
    if (combined.includes('PARCELA')) return 'Parcela';
    if (combined.includes('BODEGA')) return 'Bodega';
    if (combined.includes('ESTACIONAMIENTO')) return 'Estacionamiento';
    if (combined.includes('CASA')) return 'Casa';
    return 'Departamento';
};

const detectOperationType = (sourceUrl, transactionTypeUID) => {
    if (sourceUrl) {
        const parts = sourceUrl.toLowerCase().split('/');
        const idx = parts.indexOf('propiedades');
        if (idx !== -1 && parts.length > idx + 2) {
            const op = parts[idx + 2];
            if (op === 'venta') return 'venta';
            if (op === 'arriendo' || op === 'rent') return 'arriendo';
        }
    }
    return TRANSACTION_TYPE_MAP[transactionTypeUID] || 'venta';
};

const buildSourceUrl = (shortLinks, mlsId) => {
    if (Array.isArray(shortLinks) && shortLinks.length) {
        const es = shortLinks.find(l => l.ISOLanguageCode === 'es' || l.LanguageCode === 'es-CL');
        const pick = es || shortLinks[0];
        if (pick?.ShortLink) return { url: `https://www.remax.cl/${pick.ShortLink}`, shortLink: pick.ShortLink };
    }
    return { url: mlsId ? `https://www.remax.cl/es-cl/propiedades/${mlsId}` : 'https://www.remax.cl/', shortLink: '' };
};

/** Paginated fetcher — pulls every listing for an agent (active + history). */
export async function fetchAllListings(agentId) {
    const out = [];
    let skip = 0;
    let total = Infinity;

    while (skip < total && out.length < MAX_LISTINGS_PER_AGENT) {
        const payload = {
            count: true, skip, top: PAGE_SIZE, search: '*',
            filter: `content/AgentId eq ${agentId}`,
        };

        const res = await fetch(SEARCH_URL, {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Content-Type': 'application/json',
                'Origin': 'https://www.remax.cl',
                'Referer': `https://www.remax.cl/listings?AgentID=${agentId}`,
            },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`RE/MAX API ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = await res.json();
        const page = data.value || [];
        if (skip === 0 && typeof data['@odata.count'] === 'number') total = data['@odata.count'];
        out.push(...page);
        if (page.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
    }
    return out;
}

/** Project one raw Azure-Search document into our flat representation. */
export function projectListing(raw, agentId) {
    const p = raw.content || raw;

    const listingId = getVal(p, 'ListingId');
    const mlsId = getVal(p, 'MLSID');
    const listingReference = getVal(p, 'ListingReference');
    const listingKey = getVal(p, 'ListingKey');

    const countryId = getVal(p, 'CountryID') || 1028;
    const { url: sourceUrl, shortLink } = buildSourceUrl(getVal(p, 'ShortLinks'), mlsId);

    const geoEs = (getVal(p, 'GeoDatas') || []).find(g =>
        g?.LanguageCode === 'es-CL' || g?.LanguageCode?.startsWith?.('es')
    ) || {};
    const city = getVal(p, 'City') || geoEs.City || '';
    const province = getVal(p, 'Province') || geoEs.Province || '';
    const regionalZone = getVal(p, 'RegionalZone') || geoEs.RegionalZone || '';
    const localZone = getVal(p, 'LocalZone') || geoEs.LocalZone || '';
    const fullAddress = getVal(p, 'FullAddress') || geoEs.FullAddress || '';
    const titleAddress = getVal(p, 'TitleAddress') || geoEs.TitleAddress || '';
    const commune = city || localZone || province || '';

    let latitude = null, longitude = null;
    const loc = getVal(p, 'Location');
    if (loc?.coordinates) { longitude = loc.coordinates[0]; latitude = loc.coordinates[1]; }

    const descArr = getVal(p, 'ListingDescriptions') || [];
    const description = pickDescription(descArr, '629') || pickDescription(descArr);
    const descriptionShort = pickDescription(descArr, '1113');
    const descriptionSector = pickDescription(descArr, '3139');
    const descriptionUnit = pickDescription(descArr, '5685');

    const listingStatusUID = Number(getVal(p, 'ListingStatusUID')) || 0;
    const transactionTypeUID = Number(getVal(p, 'TransactionTypeUID')) || 0;
    const propertyTypeUID = Number(getVal(p, 'PropertyTypeUID')) || 0;
    const marketStatusUID = Number(getVal(p, 'MarketStatusUID')) || 0;

    const operationType = detectOperationType(sourceUrl, transactionTypeUID);
    const propertyType = detectPropertyType(sourceUrl, propertyTypeUID, fullAddress, description);

    const statusEntry = STATUS_MAP[listingStatusUID] || { label: 'Desconocido', active: false, closed: false };
    let statusLabel = statusEntry.label;
    if (listingStatusUID === 167 && operationType === 'arriendo') statusLabel = 'Arrendada';

    const rawImages = getVal(p, 'ListingImages') || [];
    const sortedImages = [...rawImages].sort(
        (a, b) => (parseInt(a?.Order, 10) || 0) - (parseInt(b?.Order, 10) || 0)
    );
    const imageUrls = sortedImages
        .filter(img => img?.FileName)
        .map((img, idx) => ({
            url: buildImageUrl(img.FileName, countryId),
            caption: img.Name || `Foto ${idx + 1}`,
            position: idx,
            quality: img.ImageQualityTypeUID || null,
            is_watermarked: img.IsWatermarked === '1' || img.IsWatermarked === 1,
        }));
    const primaryImage = imageUrls[0]?.url || null;

    const features = (getVal(p, 'ListingFeatures') || []).map(f => ({
        group: f.GroupingName, name: f.FeatureName, id: f.FeatureID,
    }));
    const rooms = (getVal(p, 'ListingRooms') || []).map(r => ({
        type_uid: r.RoomTypeUID, size: r.RoomSize, dimensions: r.Dimensions,
        description: r.ShortDescription,
        image: r.ImageFileName ? buildImageUrl(r.ImageFileName, countryId) : null,
    }));

    return {
        listing_id: listingId,
        mls_id: mlsId,
        listing_reference: listingReference,
        listing_key: listingKey,
        source_url: sourceUrl,
        short_link: shortLink,

        title: (descriptionShort && descriptionShort.length < 120 ? descriptionShort : null)
            || fullAddress || titleAddress || 'Propiedad sin título',
        address: fullAddress,
        commune, city, province,
        region: regionalZone,
        local_zone: localZone,
        postal_code: getVal(p, 'PostalCode') || null,
        street_name: getVal(p, 'StreetName') || null,
        street_number: getVal(p, 'StreetNumber') || null,
        apartment_number: getVal(p, 'ApartmentNumber') || null,

        property_type: propertyType,
        operation_type: operationType,
        property_type_uid: propertyTypeUID,
        transaction_type_uid: transactionTypeUID,

        listing_status_uid: listingStatusUID,
        market_status_uid: marketStatusUID,
        status_label: statusLabel,
        status: [statusLabel],
        is_active: statusEntry.active,
        is_closed: statusEntry.closed,
        is_viewable: getVal(p, 'IsViewable') === true,
        on_hold: getVal(p, 'OnHoldListing') === true,
        is_exclusive: getVal(p, 'ShowContractTypeExclusive') === true,
        hide_price_public: getVal(p, 'HidePricePublic') === true,
        show_address_public: getVal(p, 'ShowAddressPublic') === true,

        m2_total: Math.round(getVal(p, 'TotalArea') || 0),
        m2_built: Math.round(getVal(p, 'LivingArea') || getVal(p, 'BuiltArea') || 0),
        lot_size: toNum(getVal(p, 'LotSize')) ?? toNum(getVal(p, 'LotSize2')),
        bedrooms: getVal(p, 'NumberOfBedrooms') || 0,
        bathrooms: getVal(p, 'NumberOfBathrooms') || 0,
        toilet_rooms: getVal(p, 'NumberOfToiletRooms') || 0,
        total_rooms: getVal(p, 'TotalNumOfRooms') || 0,
        parking_spaces: getVal(p, 'ParkingSpaces') || getVal(p, 'NumberOfGarages') || 0,
        storage_rooms: getVal(p, 'NumberOfStorageRooms') || 0,
        floor_number: getVal(p, 'FloorLevelNumber') || getVal(p, 'FloorNumber') || null,
        total_floors: getVal(p, 'NumberOfFloors') || null,
        year_built: getVal(p, 'YearBuilt') ? Number(getVal(p, 'YearBuilt')) || null : null,

        price: toNum(getVal(p, 'ListingPrice')) ?? 0,
        currency: getVal(p, 'ListingCurrency') || 'CLP',
        price_eur: toNum(getVal(p, 'ListingPriceEuro')),
        maintenance_fee: toNum(getVal(p, 'MaintenanceFee')),
        condo_fees: toNum(getVal(p, 'CondoFees')),
        property_tax: toNum(getVal(p, 'PropertyTax')),
        sold_price: toNum(getVal(p, 'SoldPrice')),

        published_at: tsToIso(getVal(p, 'OrigListingDate')) || tsToIso(getVal(p, 'FirstUpdatedToWeb')),
        first_published_at: tsToIso(getVal(p, 'FirstUpdatedToWeb')) || tsToIso(getVal(p, 'OrigListingDate')),
        last_updated_at: tsToIso(getVal(p, 'LastUpdatedOnWeb')),
        expires_at: tsToIso(getVal(p, 'ExpiryDate')),
        sold_at: tsToIso(getVal(p, 'SoldDate')) || tsToIso(getVal(p, 'SoldStatusDate')),
        availability_date: getVal(p, 'AvailabilityDate') || null,

        latitude, longitude,

        image_url: primaryImage,
        image_urls: imageUrls,
        video_url: getVal(p, 'VideoLinkURL') || null,
        virtual_tour_url: getVal(p, 'VirtualTourURL') || getVal(p, 'VirtualRealityTourURL') || null,
        floor_plan_url: getVal(p, 'FloorPlanURL') || null,
        pdf_brochure_url: getVal(p, 'PdfBrochureURL') || null,
        qr_code_url: getVal(p, 'QRCodeUrl') || null,
        has_enhanced_multimedia: getVal(p, 'HasEnhancedMultimedia') === true,
        has_street_view: getVal(p, 'HasStreetView') === true,
        has_public_document: getVal(p, 'HasPublicDocument') === true,

        description,
        description_short: descriptionShort,
        description_sector: descriptionSector,
        description_unit: descriptionUnit,
        features, rooms,

        agent_id: agentId,
        office_id: getVal(p, 'OfficeId') || null,
        team_id: getVal(p, 'TeamID') || null,
        representing_agent_id: getVal(p, 'RepresentingAgentID') || null,
    };
}

/** Group multiple listing versions (same ROL) into one physical property + history[]. */
export function groupByReference(projected) {
    const groups = new Map();
    for (const item of projected) {
        const key = (item.listing_reference || item.mls_id || `__no_ref_${item.listing_id}`).trim();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    const sortByRecency = (a, b) =>
        (new Date(b.last_updated_at || b.published_at || 0).getTime()) -
        (new Date(a.last_updated_at || a.published_at || 0).getTime());

    const out = [];
    for (const [, items] of groups) {
        items.sort(sortByRecency);
        const current = items[0];
        const activeIdx = items.findIndex(i => i.is_viewable && !i.on_hold);
        const head = activeIdx > 0 ? items[activeIdx] : current;

        const history = items.filter(i => i !== head).map(i => ({
            listing_id: i.listing_id,
            mls_id: i.mls_id,
            published_at: i.published_at,
            expires_at: i.expires_at,
            sold_at: i.sold_at,
            price: i.price,
            currency: i.currency,
            sold_price: i.sold_price,
            listing_status_uid: i.listing_status_uid,
            status_label: i.status_label,
            operation_type: i.operation_type,
        }));

        const firstPublished = items
            .map(i => i.first_published_at || i.published_at)
            .filter(Boolean)
            .sort()[0] || head.first_published_at;

        out.push({
            ...head,
            first_published_at: firstPublished,
            total_versions: items.length,
            history,
        });
    }
    out.sort((a, b) => {
        if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
        return (new Date(b.last_updated_at || b.published_at || 0).getTime()) -
               (new Date(a.last_updated_at || a.published_at || 0).getTime());
    });
    return out;
}

/** One-shot: fetch + project + group for an agent. */
export async function scanAgentListings(remaxAgentId) {
    const raw = await fetchAllListings(String(remaxAgentId));
    const projected = raw.map(r => projectListing(r, String(remaxAgentId)));
    const properties = groupByReference(projected);
    return { properties, totalListings: raw.length };
}
