const { GoogleGenerativeAI } = require('@google/generative-ai');

// Configure Gemini API
const GEMINI_API_KEY = 'AIzaSyC5Sb7j3sjSmZpx1udMN57wxKqzur3Pt4I';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/**
 * Process text with Gemini AI
 * @param {string} text - Text to be processed by AI
 * @returns {Promise<string>} - AI response
 */
async function processWithAI(text) {
    try {
        // Initialize the model (using gemini-1.5-flash for faster responses)
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        // Generate content
        const result = await model.generateContent(text);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error('Error processing with Gemini AI:', error);
        return "Sorry, I encountered an error while processing your request.";
    }
}

module.exports = {
    processWithAI
};
