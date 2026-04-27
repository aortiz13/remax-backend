import Retell from 'retell-sdk';

const retell = new Retell({ apiKey: process.env.RETELL_API_KEY });

export async function createOutboundCall({ toPhone, metadata = {} }) {
    return retell.call.createPhoneCall({
        from_number: process.env.TWILIO_PHONE_NUMBER,
        to_number: toPhone,
        agent_id: process.env.RETELL_AGENT_ID,
        metadata,
    });
}

export async function getRetellCall(callId) {
    return retell.call.retrieve(callId);
}
