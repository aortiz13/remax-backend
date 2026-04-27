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

export async function createOutboundCall({ toPhone, metadata = {} }) {
    return client().call.createPhoneCall({
        from_number: process.env.TWILIO_PHONE_NUMBER,
        to_number: toPhone,
        agent_id: process.env.RETELL_AGENT_ID,
        metadata,
    });
}

export async function getRetellCall(callId) {
    return client().call.retrieve(callId);
}
