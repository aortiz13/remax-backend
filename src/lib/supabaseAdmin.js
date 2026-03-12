import { createClient } from '@supabase/supabase-js';

// Admin client for auth validation during migration period
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default supabaseAdmin;
