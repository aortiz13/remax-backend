/**
 * RE/MAX Listings Service
 * Shared logic for scanning and parsing RE/MAX property listings.
 * Used by both the sync route (POST /api/import/remax-listings) and the cron worker.
 */

// Helper: case-insensitive key lookup
const getVal = (obj, key) => {
    if (!obj) return undefined;
    const foundKey = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
    return foundKey ? obj[foundKey] : undefined;
};

// Helper: parse date from RE/MAX API (handles ISO strings, Unix timestamps, and epoch ms)
const parseDate = (val) => {
    if (!val) return null;
    if (typeof val === 'string') {
        // Already ISO string
        if (val.includes('T') || val.includes('-')) return val;
        // Numeric string
        val = Number(val);
    }
    if (typeof val === 'number') {
        // Unix timestamp in seconds (< 10 billion) vs milliseconds
        const ms = val < 1e11 ? val * 1000 : val;
        try {
            return new Date(ms).toISOString();
        } catch {
            return null;
        }
    }
    return null;
};

/**
 * Search RE/MAX listings API
 * @param {string} filter - OData filter string
 * @param {number} top - Max results
 * @returns {Promise<Array>} raw listing objects from RE/MAX API
 */
export async function searchRemaxListings(filter, top = 200) {
    const searchUrl = 'https://www.remax.cl/search/listing-search/docs/search';
    const payload = {
        count: true,
        skip: 0,
        top,
        search: '*',
        filter,
    };

    const response = await fetch(searchUrl, {
        method: 'POST',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Content-Type': 'application/json',
            'Origin': 'https://www.remax.cl',
            'Referer': 'https://www.remax.cl/',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`RE/MAX API Error: ${response.status} - ${text.substring(0, 200)}`);
    }

    const result = await response.json();
    return result.value || [];
}

/**
 * Parse a single RE/MAX listing into our property format
 */
export function parseListing(item, agentId) {
    const p = item.content || item;

    // ID & URL
    let listingId = getVal(p, 'ListingId') || getVal(p, 'MLSID');
    let sourceUrl = '';
    const shortLinks = getVal(p, 'ShortLinks');
    if (Array.isArray(shortLinks) && shortLinks.length > 0) {
        const link = shortLinks.find(l => l.ISOLanguageCode === 'es' || l.LanguageCode === 'es-CL') || shortLinks[0];
        if (link && link.ShortLink) {
            sourceUrl = `https://www.remax.cl/${link.ShortLink}`;
            if (!listingId) listingId = link.ShortLink.split('/').pop();
        }
    }
    if (!sourceUrl && listingId) sourceUrl = `https://www.remax.cl/propiedades/${listingId}`;

    // Listing reference (physical property identifier)
    const listingReference = getVal(p, 'ListingReference') || getVal(p, 'MLSNumber') || '';

    // Basic Info
    const title = getVal(p, 'FullAddress') || getVal(p, 'ListingName') || 'Propiedad sin título';
    const address = getVal(p, 'FullAddress') || title;

    // Extract commune
    const addressParts = getVal(p, 'AddressParts');
    let commune = '';
    if (addressParts) {
        commune = getVal(addressParts, 'City') || getVal(addressParts, 'Commune') || getVal(addressParts, 'StateOrProvince') || '';
    }
    if (!commune && address.includes(',')) {
        const parts = address.split(',').map(s => s.trim());
        commune = parts[1] || '';
    }

    const m2_total = getVal(p, 'TotalArea') || 0;
    const m2_built = getVal(p, 'LivingArea') || getVal(p, 'BuiltArea') || 0;
    const bedrooms = getVal(p, 'NumberOfBedrooms') || 0;
    const bathrooms = getVal(p, 'NumberOfBathrooms') || 0;
    const parkingSpaces = getVal(p, 'NumberOfParkingSpaces') || getVal(p, 'ParkingSpaces') || 0;
    const floorNumber = getVal(p, 'FloorNumber') || getVal(p, 'Floor') || null;
    const yearBuilt = getVal(p, 'YearBuilt') || null;
    const maintenanceFee = getVal(p, 'MaintenanceFee') || getVal(p, 'CommonExpenses') || null;

    // Description
    let desc = '';
    const descArray = getVal(p, 'ListingDescriptions');
    if (Array.isArray(descArray) && descArray.length > 0) {
        desc = descArray.find(d => d.ISOLanguageCode === 'es')?.Description || descArray[0].Description || '';
    }

    // Location
    let latitude = null;
    let longitude = null;
    const loc = getVal(p, 'Location');
    if (loc && loc.coordinates) {
        longitude = loc.coordinates[0];
        latitude = loc.coordinates[1];
    }

    // Status & viewability
    const isViewable = getVal(p, 'IsViewable') ?? true;
    const listingStatusUid = getVal(p, 'ListingStatusUID') || getVal(p, 'ListingStatusUid') || null;
    const transactionTypeUid = getVal(p, 'TransactionTypeUID') || getVal(p, 'TransactionTypeUid') || null;
    const isExclusive = getVal(p, 'IsExclusive') || false;

    // Dates
    const publishedAt = parseDate(getVal(p, 'ListingDate') || getVal(p, 'PublishedDate'));
    const expiresAt = parseDate(getVal(p, 'ExpirationDate'));
    const lastUpdatedAt = parseDate(getVal(p, 'ModifiedDate') || getVal(p, 'LastModifiedDate'));
    const soldAt = parseDate(getVal(p, 'SoldDate') || getVal(p, 'ClosedDate'));
    const soldPrice = getVal(p, 'SoldPrice') || getVal(p, 'ClosedPrice') || null;

    // Virtual tour & video
    const virtualTourUrl = getVal(p, 'VirtualTourURL') || getVal(p, 'VirtualTourUrl') || null;
    const videoUrl = getVal(p, 'VideoURL') || getVal(p, 'VideoUrl') || null;

    // --- TYPE CLASSIFICATION ---
    let propertyType = 'Departamento';
    let operationType = 'venta';
    let statusArr = ['Publicada', 'En Venta'];

    const pTypeUID = getVal(p, 'PropertyTypeUID');
    const propTypeVal = getVal(p, 'PropertyType');
    const propTypeName = typeof propTypeVal === 'string' ? propTypeVal : (getVal(propTypeVal, 'PropertyTypeName') || '');

    const titleUpper = title.toUpperCase();
    const descUpper = desc.toUpperCase();
    const typeNameUpper = propTypeName.toUpperCase();

    // 1. UID mapping
    if (pTypeUID === 194) propertyType = 'Departamento';
    else if (pTypeUID === 202) propertyType = 'Casa';
    else if (pTypeUID === 13) propertyType = 'Comercial';
    else if (pTypeUID === 19) propertyType = 'Terreno';

    // 2. Parse from URL
    if (sourceUrl) {
        const urlLower = sourceUrl.toLowerCase();
        const urlParts = urlLower.split('/');
        const propIndex = urlParts.indexOf('propiedades');

        if (propIndex !== -1 && urlParts.length > propIndex + 2) {
            const urlType = urlParts[propIndex + 1];
            const urlOp = urlParts[propIndex + 2];

            const typeMap = {
                'oficina': 'Oficina', 'departamento': 'Departamento', 'casa': 'Casa',
                'terreno': 'Terreno', 'comercial': 'Comercial', 'bodega': 'Bodega',
                'estacionamiento': 'Estacionamiento',
            };
            if (typeMap[urlType]) propertyType = typeMap[urlType];

            if (urlOp === 'venta') {
                operationType = 'venta';
                statusArr = ['Publicada', 'En Venta'];
            } else if (urlOp === 'arriendo' || urlOp === 'rent') {
                operationType = 'arriendo';
                statusArr = ['Publicada'];
            }
        }
    }

    // 3. Keyword fallback
    if (propertyType === 'Departamento' && !sourceUrl?.toLowerCase().includes('departamento')) {
        const combined = `${titleUpper} ${descUpper} ${typeNameUpper}`;
        if (combined.includes('OFICINA')) propertyType = 'Oficina';
        else if (combined.includes('LOCAL') || combined.includes('COMERCIAL')) propertyType = 'Comercial';
        else if (combined.includes('TERRENO')) propertyType = 'Terreno';
        else if (combined.includes('CASA')) propertyType = 'Casa';
    }

    // Listing status label
    let statusLabel = 'Activa';
    if (!isViewable) {
        if (listingStatusUid === 167) statusLabel = 'Concretada';
        else if (listingStatusUid === 165 || listingStatusUid === 169) statusLabel = 'Retirada';
        else statusLabel = 'Inactiva';
    }
    if (soldAt) statusLabel = soldPrice ? 'Vendida' : 'Concretada';

    if (statusLabel === 'Vendida') statusArr = ['Vendida'];
    else if (statusLabel === 'Concretada') statusArr = ['Concretada'];
    else if (statusLabel === 'Retirada') statusArr = ['Retirada'];
    else if (statusLabel === 'Inactiva') statusArr = ['Pausada'];

    // Images
    let imageUrl = null;
    const imageUrls = [];
    const images = getVal(p, 'ListingImages');
    if (Array.isArray(images) && images.length > 0) {
        const sorted = [...images].sort((a, b) => (parseInt(a.Order) || 0) - (parseInt(b.Order) || 0));
        const countryId = getVal(p, 'CountryID') || 1028;

        sorted.forEach((img, idx) => {
            if (img && img.FileName) {
                const url = `https://remax.azureedge.net/userimages/${countryId}/LargeWM/${img.FileName}`;
                if (idx === 0) imageUrl = url;
                imageUrls.push({ url, caption: img.Caption || `Foto ${idx + 1}`, position: idx });
            }
        });
    }

    return {
        source_url: sourceUrl || 'https://www.remax.cl/',
        title: title || 'Propiedad sin título',
        property_type: propertyType,
        operation_type: operationType,
        address, commune,
        m2_total: Math.round(m2_total),
        m2_built: Math.round(m2_built),
        bedrooms, bathrooms,
        description: desc,
        latitude, longitude,
        agent_id: agentId,
        status: statusArr,
        status_label: statusLabel,
        price: getVal(p, 'ListingPrice') || 0,
        currency: getVal(p, 'ListingCurrency') || 'CLP',
        image_url: imageUrl,
        image_urls: imageUrls,
        listing_id: listingId,
        listing_reference: listingReference,
        listing_status_uid: listingStatusUid,
        transaction_type_uid: transactionTypeUid,
        is_viewable: isViewable,
        is_exclusive: isExclusive,
        published_at: publishedAt,
        expires_at: expiresAt,
        last_updated_at: lastUpdatedAt,
        sold_at: soldAt,
        sold_price: soldPrice,
        year_built: yearBuilt,
        maintenance_fee: maintenanceFee,
        virtual_tour_url: virtualTourUrl,
        video_url: videoUrl,
        parking_spaces: parkingSpaces,
        floor_number: floorNumber,
    };
}

/**
 * Group listings by ListingReference (physical property).
 * A single physical property can have multiple listing versions over time.
 */
export function groupByPhysicalProperty(listings) {
    const groups = {};

    for (const listing of listings) {
        const ref = listing.listing_reference || listing.listing_id || listing.source_url;
        if (!groups[ref]) groups[ref] = [];
        groups[ref].push(listing);
    }

    return Object.values(groups).map(group => {
        group.sort((a, b) => {
            const dateA = a.published_at ? new Date(a.published_at).getTime() : 0;
            const dateB = b.published_at ? new Date(b.published_at).getTime() : 0;
            return dateB - dateA;
        });

        const current = group[0];
        const history = group.map(l => ({
            listing_id: l.listing_id,
            published_at: l.published_at,
            expires_at: l.expires_at,
            price: l.price,
            currency: l.currency,
            listing_status_uid: l.listing_status_uid,
            status_label: l.status_label,
        }));

        const firstPublished = group[group.length - 1]?.published_at || current.published_at;

        return {
            ...current,
            history,
            total_versions: group.length,
            first_published_at: firstPublished,
        };
    });
}

/**
 * Scan all listings for an agent (active + history).
 * Returns { properties, totalListings }
 */
export async function scanAgentListings(remaxAgentId) {
    // 1. Active listings
    const activeFilter = `content/AgentId eq ${remaxAgentId} and content/IsViewable eq true and content/OnHoldListing eq false`;
    const activeListings = await searchRemaxListings(activeFilter);

    // 2. All listings (for history)
    let allListings = [];
    try {
        const allFilter = `content/AgentId eq ${remaxAgentId}`;
        allListings = await searchRemaxListings(allFilter, 500);
    } catch {
        allListings = activeListings;
    }

    // 3. Parse & group
    const parsedAll = allListings.map(item => parseListing(item, remaxAgentId));
    const physicalProperties = groupByPhysicalProperty(parsedAll);

    return {
        properties: physicalProperties,
        totalListings: allListings.length,
    };
}
