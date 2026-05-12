/**
 * Non-destructive RE/MAX → DB sync.
 *
 * SAFETY RULES (enforced — do not relax without explicit approval):
 *   - NEVER deletes any row from any table.
 *   - properties: matches by listing_reference / rol_number / listing_link.
 *     * Match     → UPDATE only (a) empty fields and (b) RE/MAX-authoritative
 *                   facts (price, listing_status_uid, dates, sold info).
 *                   User-managed columns (notes, owner_id, documentation_link,
 *                   unit_number, contract dates) are never overwritten.
 *     * No match  → INSERT new row with source='remax'.
 *     * Stale     → row exists in DB but no longer in RE/MAX → left intact.
 *   - property_photos: only INSERT photo URLs not already stored.
 *   - property_listing_history: only INSERT entries with new remax_listing_id.
 *   - kpi_records: upsert today's active_portfolio; preserve every other KPI.
 *
 * Used by:
 *   - routes/sync.js (POST /api/sync/remax-listings) — manual /admin/import
 *   - worker.js     (cron 'sync-remax-listings' job)
 */

import supabaseAdmin from '../lib/supabaseAdmin.js';
import { scanAgentListings } from './remaxListingsService.js';

const INACTIVE_STATUSES = ['Vendida', 'Retirada', 'Pausada', 'Arrendada', 'Concretada'];

const isEmpty = (v) =>
    v === null || v === undefined || v === '' ||
    (Array.isArray(v) && v.length === 0);

function buildUpdatePayload(existing, incoming) {
    const update = {};

    // Fields the user might customize → only fill when empty
    const fillIfEmpty = {
        address: incoming.address,
        commune: incoming.commune,
        property_type: incoming.property_type,
        operation_type: incoming.operation_type,
        bedrooms: incoming.bedrooms,
        bathrooms: incoming.bathrooms,
        m2_total: incoming.m2_total,
        m2_built: incoming.m2_built,
        latitude: incoming.latitude,
        longitude: incoming.longitude,
        image_url: incoming.image_url,
        year_built: incoming.year_built,
        parking_spaces: incoming.parking_spaces != null ? String(incoming.parking_spaces) : null,
        floor_number: incoming.floor_number != null ? String(incoming.floor_number) : null,
        virtual_tour_url: incoming.virtual_tour_url,
        video_url: incoming.video_url,
        maintenance_fee: incoming.maintenance_fee,
        is_exclusive: incoming.is_exclusive,
        listing_link: incoming.source_url,
        notes: incoming.description,
    };
    for (const [k, v] of Object.entries(fillIfEmpty)) {
        if (isEmpty(existing[k]) && !isEmpty(v)) update[k] = v;
    }

    // RE/MAX-authoritative facts → refresh when API value is non-empty and differs
    const refreshFields = {
        price: incoming.price,
        currency: incoming.currency,
        listing_reference: incoming.listing_reference,
        remax_listing_id: incoming.listing_id,
        listing_status_uid: incoming.listing_status_uid,
        transaction_type_uid: incoming.transaction_type_uid,
        published_at: incoming.published_at,
        last_updated_at: incoming.last_updated_at,
        expires_at: incoming.expires_at,
        sold_at: incoming.sold_at,
        sold_price: incoming.sold_price,
    };
    for (const [k, v] of Object.entries(refreshFields)) {
        if (!isEmpty(v) && existing[k] !== v) update[k] = v;
    }

    // Status: only set when empty, or when API reports a closed/paused/withdrawn state
    if (isEmpty(existing.status)) {
        update.status = incoming.status;
    } else if (incoming.is_closed || ['Pausada', 'Retirada'].includes(incoming.status_label)) {
        const arr = Array.isArray(existing.status) ? existing.status : [existing.status];
        if (!arr.includes(incoming.status_label)) update.status = incoming.status;
    }

    update.source = 'remax';
    update.updated_at = new Date().toISOString();
    return update;
}

// Photos: only INSERT new URLs
async function syncPhotos(propertyId, agentId, p) {
    if (!Array.isArray(p.image_urls) || p.image_urls.length === 0) return 0;

    const { data: existing } = await supabaseAdmin
        .from('property_photos')
        .select('url')
        .eq('property_id', propertyId);

    const existingUrls = new Set((existing || []).map(r => r.url));
    const toInsert = p.image_urls
        .filter(img => !existingUrls.has(img.url))
        .map(img => ({
            property_id: propertyId,
            agent_id: agentId,
            url: img.url,
            caption: img.caption,
            position: img.position,
            source: 'remax',
        }));

    if (toInsert.length === 0) return 0;
    const { error } = await supabaseAdmin.from('property_photos').insert(toInsert);
    if (error) {
        console.error(`[sync] photo insert error property=${propertyId}: ${error.message}`);
        return 0;
    }
    return toInsert.length;
}

// History: only INSERT new remax_listing_id entries
async function syncHistory(propertyId, agentId, p) {
    if (!Array.isArray(p.history) || p.history.length === 0) return 0;

    const { data: existing } = await supabaseAdmin
        .from('property_listing_history')
        .select('remax_listing_id')
        .eq('property_id', propertyId);

    const existingIds = new Set((existing || []).map(r => String(r.remax_listing_id)));
    const rows = p.history
        .filter(h => !existingIds.has(String(h.listing_id)))
        .map(h => ({
            property_id: propertyId,
            listing_reference: p.listing_reference,
            remax_listing_id: h.listing_id,
            published_at: h.published_at,
            expired_at: h.expires_at,
            price: h.price,
            currency: h.currency,
            listing_status_uid: h.listing_status_uid,
            status_label: h.status_label,
            agent_id: agentId,
        }));

    if (rows.length === 0) return 0;
    const { error } = await supabaseAdmin.from('property_listing_history').insert(rows);
    if (error) {
        console.error(`[sync] history insert error property=${propertyId}: ${error.message}`);
        return 0;
    }
    return rows.length;
}

// KPI: upsert today's active_portfolio, preserve everything else
async function upsertDailyKpi(agentId, activePortfolio) {
    const todayStr = new Date().toISOString().split('T')[0];
    const { data: existing } = await supabaseAdmin
        .from('kpi_records')
        .select('id')
        .eq('agent_id', agentId)
        .eq('period_type', 'daily')
        .eq('date', todayStr)
        .maybeSingle();

    if (existing) {
        await supabaseAdmin.from('kpi_records')
            .update({ active_portfolio: activePortfolio })
            .eq('id', existing.id);
    } else {
        await supabaseAdmin.from('kpi_records').insert({
            agent_id: agentId,
            period_type: 'daily',
            date: todayStr,
            active_portfolio: activePortfolio,
            new_listings: 0, conversations_started: 0, relational_coffees: 0,
            sales_interviews: 0, buying_interviews: 0, commercial_evaluations: 0,
            price_reductions: 0, portfolio_visits: 0, buyer_visits: 0,
            offers_in_negotiation: 0, signed_promises: 0,
            billing_primary: 0, referrals_count: 0, billing_secondary: 0,
        });
    }
}

/**
 * Sync one agent's portfolio.
 * @param {object} agent — { id, remax_agent_id, first_name?, last_name? }
 * @param {object} [opts]
 * @param {boolean} [opts.includeProperties=false] — include the per-property detail in the result
 * @returns {Promise<object>} per-agent result with counts, errors and optionally properties[]
 */
export async function syncAgent(agent, opts = {}) {
    const { includeProperties = false } = opts;
    const result = {
        agent_id: agent.id,
        remax_agent_id: agent.remax_agent_id,
        name: `${agent.first_name || ''} ${agent.last_name || ''}`.trim(),
        raw_listings: 0,
        physical_properties: 0,
        inserted: 0,
        updated: 0,
        skipped_no_change: 0,
        photos_added: 0,
        history_added: 0,
        active_portfolio: 0,
        errors: [],
        properties: undefined,
    };
    const outcomeByKey = {};

    try {
        const { properties, totalListings } = await scanAgentListings(agent.remax_agent_id);
        result.raw_listings = totalListings;
        result.physical_properties = properties.length;
        if (properties.length === 0) return result;

        // Fetch existing rows for this agent (one query, indexed)
        const { data: existingRows, error: existingErr } = await supabaseAdmin
            .from('properties')
            .select(`
                id, rol_number, listing_reference, listing_link, source, address, commune,
                property_type, operation_type, price, currency, bedrooms, bathrooms,
                m2_total, m2_built, notes, latitude, longitude, image_url,
                published_at, last_updated_at, expires_at, sold_at, sold_price,
                listing_status_uid, transaction_type_uid, remax_listing_id,
                is_exclusive, year_built, maintenance_fee, virtual_tour_url, video_url,
                parking_spaces, floor_number, status, owner_id, documentation_link, unit_number
            `)
            .eq('agent_id', agent.id);
        if (existingErr) throw existingErr;

        const byRef = {};
        const byLink = {};
        for (const row of existingRows || []) {
            if (row.listing_reference?.trim()) byRef[row.listing_reference.trim()] = row;
            if (row.rol_number?.trim()) byRef[row.rol_number.trim()] = row;
            if (row.listing_link?.trim()) byLink[row.listing_link.trim()] = row;
        }

        for (const p of properties) {
            const key = p.listing_reference || p.mls_id || p.source_url;
            try {
                const ref = (p.listing_reference || '').trim();
                const matched = (ref && byRef[ref]) || (p.source_url && byLink[p.source_url]);

                if (matched) {
                    const update = buildUpdatePayload(matched, p);
                    const meaningfulKeys = Object.keys(update).filter(k => k !== 'updated_at' && k !== 'source');
                    if (meaningfulKeys.length === 0) {
                        result.skipped_no_change++;
                        outcomeByKey[key] = 'skipped';
                    } else {
                        if (isEmpty(matched.rol_number) && p.listing_reference) {
                            update.rol_number = p.listing_reference;
                        }
                        const { error: upErr } = await supabaseAdmin
                            .from('properties')
                            .update(update)
                            .eq('id', matched.id);
                        if (upErr) {
                            result.errors.push(`update ${matched.id}: ${upErr.message}`);
                        } else {
                            result.updated++;
                            outcomeByKey[key] = 'updated';
                            result.photos_added += await syncPhotos(matched.id, agent.id, p);
                            result.history_added += await syncHistory(matched.id, agent.id, p);
                        }
                    }
                } else {
                    const insertPayload = {
                        address: p.address || p.title,
                        commune: p.commune,
                        property_type: p.property_type,
                        operation_type: p.operation_type,
                        price: p.price || 0,
                        currency: p.currency || 'CLP',
                        bedrooms: p.bedrooms || 0,
                        bathrooms: p.bathrooms || 0,
                        m2_total: p.m2_total,
                        m2_built: p.m2_built,
                        notes: p.description,
                        listing_link: p.source_url,
                        latitude: p.latitude,
                        longitude: p.longitude,
                        status: p.status,
                        source: 'remax',
                        agent_id: agent.id,
                        image_url: p.image_url,
                        published_at: p.published_at,
                        last_updated_at: p.last_updated_at,
                        expires_at: p.expires_at,
                        sold_at: p.sold_at,
                        sold_price: p.sold_price,
                        listing_status_uid: p.listing_status_uid,
                        transaction_type_uid: p.transaction_type_uid,
                        listing_reference: p.listing_reference,
                        rol_number: p.listing_reference,
                        remax_listing_id: p.listing_id,
                        is_exclusive: p.is_exclusive,
                        year_built: p.year_built,
                        maintenance_fee: p.maintenance_fee,
                        virtual_tour_url: p.virtual_tour_url,
                        video_url: p.video_url,
                        parking_spaces: p.parking_spaces != null ? String(p.parking_spaces) : null,
                        floor_number: p.floor_number != null ? String(p.floor_number) : null,
                    };

                    const { data: inserted, error: insErr } = await supabaseAdmin
                        .from('properties')
                        .insert(insertPayload)
                        .select('id')
                        .single();

                    if (insErr) {
                        result.errors.push(`insert ${p.listing_reference || p.source_url}: ${insErr.message}`);
                    } else if (inserted) {
                        result.inserted++;
                        outcomeByKey[key] = 'inserted';
                        result.photos_added += await syncPhotos(inserted.id, agent.id, p);
                        result.history_added += await syncHistory(inserted.id, agent.id, p);
                    }
                }
            } catch (perErr) {
                result.errors.push(`property ${p.listing_reference}: ${perErr?.message || perErr}`);
            }
        }

        result.active_portfolio = properties.filter(p =>
            !p.status.some(s => INACTIVE_STATUSES.includes(s))
        ).length;
        await upsertDailyKpi(agent.id, result.active_portfolio);

        if (includeProperties) {
            result.properties = properties.map(p => ({
                listing_reference: p.listing_reference,
                listing_id: p.listing_id,
                mls_id: p.mls_id,
                source_url: p.source_url,
                title: p.title,
                address: p.address,
                commune: p.commune,
                city: p.city,
                region: p.region,
                property_type: p.property_type,
                operation_type: p.operation_type,
                status: p.status,
                status_label: p.status_label,
                is_active: p.is_active,
                is_closed: p.is_closed,
                is_exclusive: p.is_exclusive,
                price: p.price,
                currency: p.currency,
                sold_price: p.sold_price,
                sold_at: p.sold_at,
                published_at: p.published_at,
                first_published_at: p.first_published_at,
                last_updated_at: p.last_updated_at,
                expires_at: p.expires_at,
                bedrooms: p.bedrooms,
                bathrooms: p.bathrooms,
                m2_total: p.m2_total,
                m2_built: p.m2_built,
                year_built: p.year_built,
                parking_spaces: p.parking_spaces,
                floor_number: p.floor_number,
                maintenance_fee: p.maintenance_fee,
                latitude: p.latitude,
                longitude: p.longitude,
                image_url: p.image_url,
                image_count: Array.isArray(p.image_urls) ? p.image_urls.length : 0,
                video_url: p.video_url,
                virtual_tour_url: p.virtual_tour_url,
                feature_count: Array.isArray(p.features) ? p.features.length : 0,
                room_count: Array.isArray(p.rooms) ? p.rooms.length : 0,
                total_versions: p.total_versions,
                history_summary: Array.isArray(p.history)
                    ? p.history.map(h => ({
                        price: h.price, currency: h.currency,
                        status_label: h.status_label, published_at: h.published_at,
                    }))
                    : [],
                outcome: outcomeByKey[p.listing_reference || p.mls_id || p.source_url] || 'skipped',
            }));
        }

    } catch (agentErr) {
        result.errors.push(`agent: ${agentErr?.message || agentErr}`);
    }

    return result;
}

/**
 * Sync many agents (sequentially, to be gentle on the RE/MAX API).
 * @param {string[]} [remaxAgentIds] — scope to specific IDs; omitted = all agents with a remax_agent_id
 * @param {object} [opts]
 * @param {boolean} [opts.includeProperties=false]
 * @returns {Promise<object>} { success, duration_ms, results, totals }
 */
export async function syncAllAgents(remaxAgentIds, opts = {}) {
    const t0 = Date.now();
    let query = supabaseAdmin
        .from('profiles')
        .select('id, first_name, last_name, remax_agent_id')
        .not('remax_agent_id', 'is', null)
        .neq('remax_agent_id', '');
    if (Array.isArray(remaxAgentIds) && remaxAgentIds.length) {
        query = query.in('remax_agent_id', remaxAgentIds.map(String));
    }
    const { data: agents, error: agentsErr } = await query;
    if (agentsErr) throw agentsErr;

    const results = [];
    let totalInserted = 0, totalUpdated = 0, totalPhotos = 0, totalHistory = 0, totalSkipped = 0;
    for (const agent of agents || []) {
        const r = await syncAgent(agent, opts);
        results.push(r);
        totalInserted += r.inserted;
        totalUpdated += r.updated;
        totalSkipped += r.skipped_no_change;
        totalPhotos += r.photos_added;
        totalHistory += r.history_added;
    }

    return {
        success: true,
        duration_ms: Date.now() - t0,
        agents_processed: results.length,
        properties_inserted: totalInserted,
        properties_updated: totalUpdated,
        properties_skipped: totalSkipped,
        photos_added: totalPhotos,
        history_added: totalHistory,
        results,
    };
}
