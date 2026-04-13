/**
 * OpenAI Whisper Audio Transcriber
 * Sends audio to OpenAI Whisper API for transcription
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Transcribe an audio buffer using OpenAI Whisper API
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {string} format - File extension (webm, ogg, mp3, etc.)
 * @returns {{ text: string, segments: Array }} Transcription result
 */
export async function transcribeAudio(audioBuffer, format = 'webm') {
    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable not set');
    }

    // Create a File-like blob for the FormData
    const blob = new Blob([audioBuffer], { type: `audio/${format}` });

    const formData = new FormData();
    formData.append('file', blob, `recording.${format}`);
    formData.append('model', 'whisper-1');
    formData.append('language', 'es'); // Spanish
    formData.append('response_format', 'verbose_json'); // Includes word-level timestamps
    formData.append('timestamp_granularities[]', 'segment');

    console.log('[Whisper] Sending audio for transcription...');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Whisper API error (${response.status}): ${errorText}`);
    }

    const result = await response.json();

    console.log(`[Whisper] ✅ Transcription complete: ${result.text?.length || 0} chars, ${result.segments?.length || 0} segments`);

    return {
        text: result.text || '',
        segments: result.segments || [],
        language: result.language || 'es',
        duration: result.duration || 0,
    };
}
