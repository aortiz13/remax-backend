/**
 * OpenAI GPT-4o Form Extractor
 * Extracts structured candidate information from meeting transcripts
 * using OpenAI Structured Outputs for guaranteed schema adherence
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `Eres un asistente de reclutamiento de RE/MAX Exclusive, una empresa de bienes raíces en Chile.

Tu trabajo es analizar la transcripción de una entrevista de reclutamiento y extraer información clave del candidato.

REGLAS IMPORTANTES:
1. Solo extrae información que el CANDIDATO dijo sobre sí mismo, no lo que dijo el entrevistador.
2. El entrevistador es quien hace preguntas. El candidato es quien responde con información personal.
3. Si algún dato no fue mencionado, devuelve null para ese campo.
4. Para "is_available_full_time", responde true si el candidato indicó que está disponible full-time/tiempo completo, false si indicó que no, null si no se discutió.
5. Para "current_occupation", describe brevemente a qué se dedica actualmente el candidato.
6. En "confidence_notes", incluye observaciones sobre la calidad de la información extraída y cualquier dato adicional relevante que hayas notado.
7. En "additional_insights", incluye cualquier otra información relevante mencionada (experiencia en bienes raíces, motivaciones, disponibilidad horaria, etc.)`;

const EXTRACTION_SCHEMA = {
    type: 'object',
    properties: {
        first_name: {
            type: ['string', 'null'],
            description: 'Nombre del candidato',
        },
        last_name: {
            type: ['string', 'null'],
            description: 'Apellido del candidato',
        },
        age: {
            type: ['integer', 'null'],
            description: 'Edad del candidato en años',
        },
        current_occupation: {
            type: ['string', 'null'],
            description: 'A qué se dedica actualmente el candidato',
        },
        is_available_full_time: {
            type: ['boolean', 'null'],
            description: 'Si el candidato está disponible para trabajar tiempo completo',
        },
        confidence_notes: {
            type: 'string',
            description: 'Notas sobre la confianza en la extracción y observaciones del análisis',
        },
        additional_insights: {
            type: ['string', 'null'],
            description: 'Otros datos relevantes mencionados: experiencia en bienes raíces, motivaciones, educación, etc.',
        },
    },
    required: ['first_name', 'last_name', 'age', 'current_occupation', 'is_available_full_time', 'confidence_notes'],
    additionalProperties: false,
};

/**
 * Extract candidate form fields from a meeting transcript
 * @param {string} transcriptText - Full transcript text
 * @returns {object} Extracted form fields
 */
export async function extractFormFromTranscript(transcriptText) {
    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable not set');
    }

    if (!transcriptText || transcriptText.length < 20) {
        throw new Error('Transcript too short to extract meaningful data');
    }

    // Truncate very long transcripts to fit context window
    const maxChars = 30000; // ~7500 tokens for GPT-4o
    const truncatedTranscript = transcriptText.length > maxChars
        ? transcriptText.substring(0, maxChars) + '\n\n[... transcripción truncada ...]'
        : transcriptText;

    console.log(`[GPT-4o] Extracting form from ${truncatedTranscript.length} chars...`);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `Analiza la siguiente transcripción de una entrevista de reclutamiento y extrae la información del candidato:\n\n---\n${truncatedTranscript}\n---`,
                },
            ],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'candidate_extraction',
                    strict: true,
                    schema: EXTRACTION_SCHEMA,
                },
            },
            temperature: 0.1, // Very deterministic
            max_tokens: 1000,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GPT-4o API error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error('No content in GPT-4o response');
    }

    const extracted = JSON.parse(content);
    console.log(`[GPT-4o] ✅ Extracted:`, JSON.stringify(extracted, null, 2));

    return extracted;
}
