import Retell from 'retell-sdk';

let _retell;
function client() {
    if (!_retell) {
        if (!process.env.RETELL_API_KEY) {
            throw new Error('RETELL_API_KEY is not set in environment');
        }
        _retell = new Retell({ apiKey: process.env.RETELL_API_KEY });
    }
    return _retell;
}

export async function createOutboundCall({ toPhone, metadata = {}, agentId, dynamicVariables }) {
    const payload = {
        from_number: process.env.TWILIO_PHONE_NUMBER,
        to_number: toPhone,
        agent_id: agentId || process.env.RETELL_AGENT_ID,
        metadata,
    };
    if (dynamicVariables) payload.retell_llm_dynamic_variables = dynamicVariables;
    return client().call.createPhoneCall(payload);
}

export async function getRetellCall(callId) {
    return client().call.retrieve(callId);
}
