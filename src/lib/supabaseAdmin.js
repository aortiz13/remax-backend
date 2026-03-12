import { createClient } from '@supabase/supabase-js';

// The admin client needs a URL that serves /auth/v1 and /rest/v1
// remax-app proxies both, so:
//   - From remax-app itself: http://localhost:3000
//   - From remax-worker: http://remax-crm_remax-app:3000 (Docker network)
// Set SUPABASE_URL accordingly in each service's env vars
const INTERNAL_URL = process.env.SUPABASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const supabaseAdmin = createClient(
    INTERNAL_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default supabaseAdmin;
