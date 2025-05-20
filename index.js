const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
// Replace MySQL with SQLite
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { processWithAI } = require('./aiHelper');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Replace with your actual Telegram bot token
const token = '7999022064:AAGoG16qjaqDIeNmwAOzqcZkvDA1A8jErNQ';
const bot = new TelegramBot(token, { polling: true });

// Replace with your group chat ID 
const groupChatId = -4791416253;

// SQLite database configuration - pointing to existing db file
const dbPath = path.join(__dirname, 'daily_quiz.db');

// Database helper function
async function getDb() {
    return await open({
        filename: dbPath,
        driver: sqlite3.Database
    });
}

// Track users who have started the bot
const startedUsers = new Map();

// Simple question tracker - only track quiz questions
const questionTracker = [];

// Question settings
const QUESTION_TIMEOUT_MINS = 30; // Question expires after 30 minutes

/**
 * Update or create a question record for the specified chat
 * @param {Object} question - Question data object
 * @param {number} chatId - Chat ID
 * @returns {Object} - The created/updated question object
 */
function trackQuestion(question, chatId) {
    // Find existing question for this chat
    const existingIndex = questionTracker.findIndex(q => q.chatId === chatId && q.date === question.date);
    
    if (existingIndex !== -1) {
        // Replace existing question
        questionTracker[existingIndex] = question;
        return question;
    } else {
        // Add new question
        questionTracker.push(question);
        return question;
    }
}

/**
 * Remove expired questions from the tracker
 * Questions older than QUESTION_TIMEOUT_MINS minutes are removed
 */
function cleanupExpiredQuestions() {
    const now = new Date();
    const timeoutMs = QUESTION_TIMEOUT_MINS * 60 * 1000;
    
    // Filter out expired questions
    const initialLength = questionTracker.length;
    const filteredQuestions = questionTracker.filter(q => {
        const age = now - new Date(q.time);
        return age < timeoutMs;
    });
    
    // Replace the array with filtered questions
    questionTracker.length = 0;
    filteredQuestions.forEach(q => questionTracker.push(q));
    
    const removedCount = initialLength - questionTracker.length;
    if (removedCount > 0) {
        console.log(`Removed ${removedCount} expired questions from tracker.`);
    }
}

/**
 * Gets the active question for a specific chat, if it exists and isn't expired
 * @param {number} chatId - The chat ID
 * @returns {Object|null} - Question object or null if not found/expired
 */
function getActiveQuestion(chatId) {
    const now = new Date();
    const timeoutMs = QUESTION_TIMEOUT_MINS * 60 * 1000;
    
    const question = questionTracker.find(q => q.chatId === chatId);
    
    if (!question) return null;
    
    // Check if question is expired
    const age = now - new Date(question.time);
    if (age > timeoutMs) {
        return null; // Question has expired
    }
    
    return question;
}

/**
 * Clear all questions from the tracker
 */
function clearAllQuestions() {
    const count = questionTracker.length;
    questionTracker.length = 0;
    return count;
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredQuestions, 5 * 60 * 1000);

// Set bot commands
bot.setMyCommands([
    { command: 'start', description: 'Start the bot and see welcome message' },
    { command: 'help', description: 'Show available commands' },
    { command: 'question', description: 'Send a test question' },
    { command: 'monthly', description: 'Show monthly leaderboard' },
    { command: 'ai', description: 'Ask the AI a question (e.g., /ai What is the capital of France?)' },
    // Admin commands will be visible to all but only work for admins
    { command: 'genquestion', description: 'Generate a new quiz question with AI (admin only)' },
    { command: 'genbulkquestion', description: 'Generate multiple unique quiz questions (admin only)' },
    { command: 'exportquestions', description: 'Export all questions to Excel (admin only)' },
    { command: 'report', description: 'Export scorebord to PDF (admin only)' },
    { command: 'senddailyquestions', description: 'Send daily questions to all registerd users in the bot (admin only)' }
]);

/**
 * Check if a user is registered in the users table
 * @param {number} userId - Telegram user ID
 * @returns {Promise<boolean>} - Whether the user is registered
 */
async function isUserRegistered(userId) {
    const db = await getDb();
    const row = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
    await db.close();
    return row !== undefined;
}

/**
 * Register a new user in the users table
 * @param {number} userId - Telegram user ID
 * @param {string} username - Telegram username
 * @returns {Promise<void>}
 */
async function registerUser(userId, username) {
    const db = await getDb();
    await db.run('INSERT INTO users (user_id, username) VALUES (?, ?, ?)', userId, username);
    await db.close();
}

// Define admin user IDs (replace with actual admin Telegram IDs)
const adminUsers = [
    754993191,  // Replace with your Telegram user ID
    1348059186
];

/**
 * Check if a user is an admin
 * @param {number} userId - Telegram user ID
 * @returns {boolean} - Whether the user is an admin
 */
function isAdmin(userId) {
    return adminUsers.includes(userId);
}

/**
 * Get all registered users from the database
 * @returns {Promise<Array>} - Array of user objects with user_id and username
 */
async function getAllUsers() {
    const db = await getDb();
    const rows = await db.all('SELECT user_id, username FROM users');
    await db.close();
    return rows;
}

// Start command handler
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    
    // Check if user is registered and register if not
    try {
        const registered = await isUserRegistered(userId);
        if (!registered) {
            await registerUser(userId, username);
            console.log(`New user registered: ${username} (${userId})`);
        }
    } catch (error) {
        console.error('Error registering user:', error);
    }
    
    // Mark user as started
    startedUsers.set(userId, true);
    
    const welcomeMessage = 
        `?? Welcome ${msg.from.first_name}!\n\n` +
        `I'm a quiz bot with AI capabilities. Here's what I can do:\n\n` +
        `- Answer your questions with AI in private chat\n` +
        `- Run daily quizzes in groups\n` +
        `- Track points and show leaderboards\n\n` +
        `Type /help to see all available commands.`;
    
    bot.sendMessage(chatId, welcomeMessage);
});

// Help command handler
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    let helpMessage = 
        `?? Available Commands:\n\n` +
        `- /start - Start the bot\n` +
        `- /help - Show this help message\n` +
        `- /question - Send a quiz question\n` +
        `- /monthly - Show monthly leaderboard\n` +
        `- /ai - Ask the AI a question (e.g., /ai What is the capital of France?)\n` +
        `- score or ????? - Check your points\n\n`;
        
    // Add specific help for private chats
    if (msg.chat.type === 'private') {
        helpMessage += 
            `In private chat, you can:\n` +
            `- Get quiz questions with /question\n` +
            `- Answer questions to earn points\n` +
            `- Use /ai followed by your query to use AI\n`;
    } else {
        helpMessage += `The /ai command is only available to admins in group chats.\n`;
    }
    
    // Add admin commands
    if (isAdmin(userId)) {
        helpMessage += 
            `\n?? Admin Commands:\n` +
            `- /genquestion [topic] - Generate a new quiz question using AI\n` +
            `- /genbulkquestion [count] [topic] - Generate multiple quiz questions\n` +
            `- /exportquestions - Export all questions to Excel\n` +
            `- /addquestion - Manually add a new question\n` +
            `- /broadcast - Send a message to all users\n` +
            `- /report - Generate a PDF points report\n` +
            `- /questions - View question statistics\n`;
    }
    
    bot.sendMessage(chatId, helpMessage);
});

// Question command handler - fixed to work in both group and DMs correctly
bot.onText(/\/question/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "🎯 Sending a random question...");
    
    // Use the correct function to send to either DM or group
    const success = await sendQuestionToChat(chatId);
    if (!success) {
        bot.sendMessage(chatId, "Sorry, I couldn't find any questions in the database.");
    }
});

// Monthly leaderboard command handler
bot.onText(/\/monthly/, async (msg) => {
    const chatId = msg.chat.id;
    await sendMonthlyLeaderboard(chatId);
});

/**
 * Fetch a random question from the questions table.
 * Uses columns: question_text, correct_answer, message_text
 */
async function fetchDailyQuestion() {
    const db = await getDb();
    // RAND() in MySQL becomes RANDOM() in SQLite
    const row = await db.get('SELECT * FROM questions ORDER BY RANDOM() LIMIT 1');
    await db.close();
    return row;
}

/**
 * Update the user's points for the current day.
 * Awards 1 point for a win.
 */
async function updateUserPoints(user_id, username) {
    const db = await getDb();
    // Replace CURDATE() with explicit date format
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD format
    
    const row = await db.get(
        'SELECT * FROM user_points WHERE user_id = ? AND last_updated = ?', 
        [user_id, today]
    );
    
    if (row) {
        await db.run(
            'UPDATE user_points SET points = points + 1 WHERE user_id = ? AND last_updated = ?', 
            [user_id, today]
        );
    } else {
        await db.run(
            'INSERT INTO user_points (user_id, username, points, last_updated) VALUES (?, ?, ?, ?)', 
            [user_id, username, 1, today]
        );
    }
    await db.close();
}

/**
 * Fetch a user's total points.
 * @param {number} userId - The Telegram user ID
 * @returns {Promise<number>} - Total points of the user
 */
async function getUserPoints(userId) {
    const db = await getDb();
    const row = await db.get(
        'SELECT SUM(points) as total_points FROM user_points WHERE user_id = ?', 
        [userId]
    );
    await db.close();
    return (row && row.total_points) || 0;
}

/**
 * Fetch the monthly leaderboard of top 10 users
 * @returns {Promise<Array>} - Array of top users with their points
 */
async function getMonthlyLeaderboard() {
    const db = await getDb();
    const now = new Date();
    // Calculate monthly points starting from the first of the month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const formattedMonthStart = monthStart.toISOString().slice(0, 10);
    
    const rows = await db.all(
        `SELECT user_id, username, SUM(points) AS monthly_points 
         FROM user_points 
         WHERE last_updated >= ? 
         GROUP BY user_id 
         ORDER BY monthly_points DESC 
         LIMIT 10`,
        [formattedMonthStart]
    );
    await db.close();
    return rows;
}

/**
 * Format and send the monthly leaderboard as a message
 * @param {number} chatId - The chat ID to send the leaderboard to
 */
async function sendMonthlyLeaderboard(chatId) {
    const leaderboard = await getMonthlyLeaderboard();
    
    if (leaderboard.length > 0) {
        // Get current month name
        const monthNames = ["January", "February", "March", "April", "May", "June",
                           "July", "August", "September", "October", "November", "December"];
        const currentMonth = monthNames[new Date().getMonth()];
        
        let message = `?? Top Performers for ${currentMonth} ??\n\n`;
        leaderboard.forEach((row, index) => {
            message += `${index + 1}. ${row.username || 'Unknown'} - ${row.monthly_points} points\n`;
        });
        bot.sendMessage(chatId, message);
    } else {
        bot.sendMessage(chatId, "No points recorded this month yet. Be the first to answer correctly!");
    }
}

/**
 * Sends the daily question to the group.
 */
async function sendDailyQuestion() {
    return await sendQuestionToChat(groupChatId);
}

/**
 * Sends a question to a specific chat (can be group or private)
 * @param {number} chatId - The chat ID to send the question to
 * @returns {Promise<boolean>} - Whether a question was successfully sent
 */
async function sendQuestionToChat(chatId) {
    const question = await fetchDailyQuestion();
    if (!question) {
        console.error("No question found in the database! Did you forget to add some?");
        return false;
    }
    
    // Use the message_text field from the database for rich formatting
    const sentMsg = await bot.sendMessage(chatId, question.message_text || `Question:\n${question.question_text}`);
    
    const today = new Date().toISOString().slice(0, 10);
    
    // Store question info in our tracker
    trackQuestion({
        id: sentMsg.message_id,
        type: chatId === groupChatId ? 'group' : 'private',
        text: question.question_text,
        answer: question.correct_answer,
        chatId: chatId,
        time: new Date(),
        date: today,
        answers: [],
        expiresAt: new Date(Date.now() + QUESTION_TIMEOUT_MINS * 60 * 1000),
        hasWinner: false,
        winner: null
    }, chatId);
    
    return true;
}

/**
 * Listen for messages in the group chat.
 * Awards the first correct answer.
 */
bot.on('message', async (msg) => {
    // Skip command messages (they're handled by onText handlers)
    if (msg.text && msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userData = startedUsers.get(userId);

    // Handle question creation flow
    if (userData && userData.addingQuestion && chatId === msg.from.id) {
        const questionData = userData.questionData || {};
        
        // Step 1: Get question text
        if (!questionData.question_text && msg.text) {
            questionData.question_text = msg.text;
            startedUsers.set(userId, {
                ...userData,
                questionData
            });
            
            bot.sendMessage(chatId, 
                "?? Got the question!\n\n" +
                "Now please send the correct answer."
            );
            return;
        }
        
        // Step 2: Get correct answer
        if (questionData.question_text && !questionData.correct_answer && msg.text) {
            questionData.correct_answer = msg.text;
            
            // Generate message text automatically
            questionData.message_text = `Question: ${questionData.question_text}`;
            
            startedUsers.set(userId, {
                ...userData,
                addingQuestion: false, // Done with adding
                questionData: {}       // Clear data
            });
            
            // Save to database
            try {
                const db = await getDb();
                await db.run(
                    'INSERT INTO questions (question_text, correct_answer, message_text) VALUES (?, ?, ?)',
                    [questionData.question_text, questionData.correct_answer, questionData.message_text]
                );
                const result = await db.get('SELECT last_insert_rowid() as id');
                await db.close();
                
                bot.sendMessage(chatId, 
                    `?? Question added successfully! (ID: ${result.id})\n\n` +
                    `Question: ${questionData.question_text}\n` +
                    `Answer: ${questionData.correct_answer}`
                );
            } catch (error) {
                console.error("Error adding question:", error);
                bot.sendMessage(chatId, "?? Failed to add question: " + error.message);
            }
            
            return;
        }
    }

    // Handle all chats (private and groups)
    if (msg.text) {
        // Check for score request
        if (msg.text.trim().toLowerCase() === 'score' || msg.text.trim() === '?????') {
            const points = await getUserPoints(msg.from.id);
            bot.sendMessage(msg.chat.id, `${msg.from.first_name}, you have ${points} total points! ??`);
            return;
        }

        // Find active question for this chat
        const activeQuestion = questionTracker.find(q => {
            return q.chatId === msg.chat.id && 
                  new Date() < new Date(q.expiresAt); // Only find non-expired questions
        });

        // Process the answer if there's an active question
        if (activeQuestion) {
            // Check if question expired
            const now = new Date();
            if (now > activeQuestion.expiresAt) {
                // Only respond if they tried to answer correctly
                if (msg.text.trim().toLowerCase().includes(activeQuestion.answer.trim().toLowerCase())) {
                    bot.sendMessage(msg.chat.id, "Sorry, this question has expired.");
                }
                return;
            }
            
            // Check if there's already a winner for this question
            if (!activeQuestion.hasWinner) {
                // Check answer correctness - using includes instead of exact match
                const userAnswer = msg.text.trim().toLowerCase();
                const correctAnswer = activeQuestion.answer.trim().toLowerCase();
                const isCorrect = userAnswer.includes(correctAnswer);
                
                // Track the answer
                activeQuestion.answers.push({
                    userId: msg.from.id,
                    username: msg.from.username || msg.from.first_name,
                    text: msg.text,
                    time: new Date(),
                    isCorrect: isCorrect
                });
        
                // If correct answer, set winner
                if (isCorrect) {
                    activeQuestion.hasWinner = true;
                    activeQuestion.winner = {
                        userId: msg.from.id,
                        username: msg.from.username || msg.from.first_name,
                        time: new Date()
                    };
                    
                    // Award points
                    await updateUserPoints(msg.from.id, msg.from.username || msg.from.first_name);
                    bot.sendMessage(msg.chat.id, `Congratulations ${msg.from.first_name}! You're correct. Points are on the way. ??`);
                    
                    // For private chats, offer another question
                    if (msg.chat.type === 'private') {
                        setTimeout(() => {
                            bot.sendMessage(msg.chat.id, "Would you like another question? Use /question to get one!");
                        }, 1000);
                    }
                }
                
                // If we processed as an answer to a question, return
                return;
            }
        }
        
        // For private chats, we no longer process with AI here
        // User must use the /ai command instead
        if (msg.chat.type === 'private') {
            if (!startedUsers.has(msg.from.id)) {
                bot.sendMessage(msg.chat.id, "Please use /start to begin chatting with me.");
                return;
            }
            
            // Remind them to use commands
            bot.sendMessage(msg.chat.id, 
                "I understand commands like:\n" +
                "• /question - Get a quiz question\n" +
                "• /ai - Ask me something (e.g., /ai What's the weather like?)\n" +
                "• /help - See all available commands"
            );
            return;
        }
    }
});

// Add a handler for the AI command
bot.onText(/\/ai (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Only allow in private chats or for admins in groups
    if (msg.chat.type !== 'private' && !isAdmin(userId)) {
        return bot.sendMessage(chatId, "AI chat is only available in private conversations or for admins in groups.");
    }
    
    // Check if user has started the bot (for private chats)
    if (msg.chat.type === 'private' && !startedUsers.has(userId)) {
        return bot.sendMessage(chatId, "Please use /start to begin chatting with me.");
    }
    
    // Get the query
    const query = match[1];
    
    // Send "typing..." action while processing
    bot.sendChatAction(chatId, 'typing');
    
    try {
        // Process message with AI
        const aiResponse = await processWithAI(query);
        bot.sendMessage(chatId, aiResponse);
    } catch (error) {
        console.error('Error in AI chat:', error);
        bot.sendMessage(chatId, "Sorry, I couldn't process your request at the moment.");
    }
});

// Add a simple command to view question stats for admins
bot.onText(/\/questions/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, "? You don't have permission to use this command.");
    }
    
    if (questionTracker.length === 0) {
        return bot.sendMessage(msg.chat.id, "No questions have been tracked yet.");
    }
    
    let message = `?? Quiz Questions Tracker:\n\n`;
    message += `Total tracked questions: ${questionTracker.length}\n\n`;
    
    // Get today's questions
    const today = new Date().toISOString().slice(0, 10);
    const todayQuestions = questionTracker.filter(q => q.date === today);
    
    message += `Today's questions: ${todayQuestions.length}\n\n`;
                 
    // Show most recent 3 questions with answer counts and winners
    const recentQuestions = [...questionTracker].reverse().slice(0, 3);
    
    message += `Recent questions:\n`;
    recentQuestions.forEach((q, i) => {
        const correctAnswers = q.answers ? q.answers.filter(a => a.isCorrect).length : 0;
        const totalAnswers = q.answers ? q.answers.length : 0;
        
        // Calculate time remaining
        const now = new Date();
        const expiresAt = q.expiresAt || new Date(new Date(q.time).getTime() + QUESTION_TIMEOUT_MINS * 60 * 1000);
        const remainingMs = expiresAt - now;
        const remainingMins = Math.max(0, Math.floor(remainingMs / (60 * 1000)));
        
        message += `${i+1}. "${q.text.substring(0, 40)}..."\n`;
        message += `   Date: ${q.date}, Chat: ${q.chatId}\n`;
        message += `   Answers: ${totalAnswers} (${correctAnswers} correct)\n`;
        message += `   Status: ${remainingMins > 0 ? `Active (${remainingMins} min left)` : 'Expired'}\n`;
        message += `   Winner: ${q.hasWinner ? q.winner.username : 'None yet'}\n\n`;
    });
    
    bot.sendMessage(msg.chat.id, message);
});

/**
 * Cron job: Send the daily question every day at 9 AM server time.
 * Using UTC timezone.
 */
cron.schedule('0 9 * * *', () => {
    sendDailyQuestion();
    
    // Also clean up old questions
    cleanupExpiredQuestions();
}, {
    timezone: "UTC" // Standard timezone that works everywhere
});

/**
 * Cron job: At the end of the month, send the top 10 winners.
 * This job runs on days 28-31, then checks if tomorrow is the 1st.
 */
cron.schedule('59 23 28-31 * *', async () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (tomorrow.getDate() === 1) {
        const db = await getDb();
        // Calculate monthly points starting from the first of the month
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const formattedMonthStart = monthStart.toISOString().slice(0, 10);
        
        const rows = await db.all(
            `SELECT user_id, username, SUM(points) AS monthly_points 
             FROM user_points 
             WHERE last_updated >= ? 
             GROUP BY user_id 
             ORDER BY monthly_points DESC 
             LIMIT 10`,
            [formattedMonthStart]
        );
        await db.close();
        
        if (rows.length > 0) {
            let message = "?? Top 10 Winners of the Month ??\n\n";
            rows.forEach((row, index) => {
                message += `${index + 1}. ${row.username || 'Unknown'} - ${row.monthly_points} points\n`;
            });
            bot.sendMessage(groupChatId, message);
        } else {
            bot.sendMessage(groupChatId, "No winners recorded this month. Looks like it's time to step up your game!");
        }
    }
}, {
    timezone: "UTC" // Standard timezone that works everywhere
});

// Broadcast command handler - format: /broadcast Message to send to all users
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    // Check if the user is an admin
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, "? You don't have permission to use this command.");
        return;
    }
    
    const broadcastMessage = match[1]; // The captured message text
    
    // Send a confirmation of the broadcast starting
    bot.sendMessage(chatId, "?? Starting broadcast. Please wait...");
    
    try {
        // Get all users
        const users = await getAllUsers();
        let successCount = 0;
        let failCount = 0;
        
        // Status update interval
        let lastStatusUpdate = Date.now();
        const statusInterval = 3000; // Update status every 3 seconds
        
        // Send the message to each user
        for (let i = 0; i < users.length; i++) {
            const user = users[i];
            try {
                await bot.sendMessage(user.user_id, 
                    `?? *ANNOUNCEMENT*\n\n${broadcastMessage}`, 
                    { parse_mode: 'Markdown' }
                );
                successCount++;
                
                // Update status periodically
                if (Date.now() - lastStatusUpdate > statusInterval) {
                    await bot.sendMessage(chatId, 
                        `?? Broadcasting: ${i+1}/${users.length} messages sent (${successCount} successful, ${failCount} failed)`
                    );
                    lastStatusUpdate = Date.now();
                }
                
                // Add a small delay to avoid hitting Telegram's rate limits
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (err) {
                console.error(`Failed to send message to ${user.username} (${user.user_id}):`, err.message);
                failCount++;
            }
        }
        
        // Send final status
        bot.sendMessage(chatId, 
            `? Broadcast complete!\n\n` +
            `Total users: ${users.length}\n` +
            `? Successful: ${successCount}\n` +
            `? Failed: ${failCount}`
        );
        
    } catch (error) {
        console.error('Error in broadcast:', error);
        bot.sendMessage(chatId, "? Error occurred while broadcasting: " + error.message);
    }
});

// Add a new command for clearing private chats
bot.onText(/\/clearprivatechats/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    // Check if the user is an admin
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, "? You don't have permission to use this command.");
        return;
    }
    
    // Warn about Telegram's limitations
    const confirmMsg = await bot.sendMessage(
        chatId, 
        "?? *WARNING: DELETING PRIVATE MESSAGES*\n\n" +
        "This command will attempt to delete all messages in private chats between the bot and users.\n\n" +
        "Limitations:\n" +
        "� Telegram only allows bots to delete messages sent by them\n" +
        "� Only messages less than 48 hours old can be deleted\n" +
        "� We'll attempt a brute force approach (trying message IDs)\n\n" +
        "Do you want to proceed?",
        {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "? Yes, proceed", callback_data: "confirm_clear_private" },
                        { text: "? Cancel", callback_data: "cancel_clear_private" }
                    ]
                ]
            }
        }
    );
});

// Handle the callback for clearing private chats

// Add a command to generate points report in PDF
bot.onText(/\/report/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    // Only admins can generate reports
    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, "❌ You don't have permission to use this command.");
    }
    
    // Only allow in private chats for security
    if (msg.chat.type !== 'private') {
        return bot.sendMessage(chatId, "❌ This command can only be used in private chat with the bot for security reasons.");
    }
    
    bot.sendMessage(chatId, "📊 Generating points report. This may take a moment...");
    
    try {
        // Generate and send the report
        const reportFile = await generatePointsReport();
        await bot.sendDocument(chatId, reportFile, {
            caption: "📈 Here's the complete points report for all users."
        });
        
        // Clean up the file after sending
        fs.unlink(reportFile, (err) => {
            if (err) console.error('Error deleting temporary PDF file:', err);
        });
    } catch (error) {
        console.error('Error generating report:', error);
        bot.sendMessage(chatId, "❌ Failed to generate the report: " + error.message);
    }
});

/**
 * Generates a PDF report of all user points
 * @returns {Promise<string>} Path to the generated PDF file
 */
async function generatePointsReport() {
    // Create a folder for reports if it doesn't exist
    const reportsDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir);
    }
    
    // Generate unique filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportsDir, `points-report-${timestamp}.pdf`);
    
    // Create a new PDF document
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(reportPath);
    
    // Pipe the PDF to the file
    doc.pipe(stream);
    
    // Get all the necessary data
    const db = await getDb();
    
    // 1. Get all users
    const users = await db.all('SELECT user_id, username FROM users');
    
    // 2. Get all point records
    const allPoints = await db.all(`
        SELECT user_id, username, points, last_updated 
        FROM user_points 
        ORDER BY last_updated DESC, points DESC
    `);
    
    // 3. Get total points per user
    const userTotals = await db.all(`
        SELECT user_id, username, SUM(points) as total_points 
        FROM user_points 
        GROUP BY user_id 
        ORDER BY total_points DESC
    `);
    
    // 4. Get monthly stats
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const formattedMonthStart = monthStart.toISOString().slice(0, 10);
    
    const monthlyPoints = await db.all(`
        SELECT user_id, username, SUM(points) AS monthly_points 
        FROM user_points 
        WHERE last_updated >= ? 
        GROUP BY user_id 
        ORDER BY monthly_points DESC`,
        [formattedMonthStart]
    );
    
    await db.close();
    
    // Format the PDF content
    
    // Title
    doc.fontSize(25)
       .text('Quiz Bot Points Report', { align: 'center' })
       .moveDown(0.5);
    
    // Date of report
    doc.fontSize(12)
       .text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' })
       .moveDown(1);
    
    // Summary statistics
    doc.fontSize(16)
       .text('Summary', { underline: true })
       .moveDown(0.5);
       
    doc.fontSize(12)
       .text(`Total Users: ${users.length}`)
       .text(`Total Point Records: ${allPoints.length}`)
       .moveDown(1);
    
    // Top users section
    doc.fontSize(16)
       .text('Top Users (All Time)', { underline: true })
       .moveDown(0.5);
    
    // Create a table for top users
    let yPos = doc.y;
    doc.fontSize(12);
    
    // Table headers
    doc.font('Helvetica-Bold')
       .text('Rank', 50, yPos)
       .text('Username', 100, yPos)
       .text('Total Points', 300, yPos)
       .moveDown(0.5);
    
    yPos = doc.y;
    doc.font('Helvetica');
    console.log(userTotals)
    // Table rows - show top 15 users
    const topUsers = userTotals.slice(0, 15);
    topUsers.forEach((user, index) => {
        
        doc.text(`${index + 1}`, 50, yPos)
           .text(user.username, 100, yPos)
           .text(user.total_points.toString(), 300, yPos)
           .moveDown(0.5);
        
        yPos = doc.y;
        
        // Add a new page if we're running out of space
        if (yPos > 700) {
            doc.addPage();
            yPos = 50;
        }
    });
    
    // Monthly statistics
    doc.addPage();
    doc.fontSize(16)
       .text('Monthly Statistics', { underline: true })
       .moveDown(0.5);
    
    // Get month name
    const monthNames = ["January", "February", "March", "April", "May", "June",
                       "July", "August", "September", "October", "November", "December"];
    const currentMonth = monthNames[new Date().getMonth()];
    
    doc.fontSize(12)
       .text(`Points for ${currentMonth} ${new Date().getFullYear()}`)
       .moveDown(0.5);
    
    // Monthly top users table
    yPos = doc.y;
    doc.fontSize(12);
    
    // Table headers
    doc.font('Helvetica-Bold')
       .text('Rank', 50, yPos)
       .text('Username', 100, yPos)
       .text('Monthly Points', 300, yPos)
       .moveDown(0.5);
    
    yPos = doc.y;
    doc.font('Helvetica');
    
    // Table rows - show top 15 monthly users
    const topMonthlyUsers = monthlyPoints.slice(0, 15);
    topMonthlyUsers.forEach((user, index) => {
        doc.text(`${index + 1}`, 50, yPos)
           .text(user.username || 'Unknown', 100, yPos)
           .text(user.monthly_points.toString(), 300, yPos)
           .moveDown(0.5);
        
        yPos = doc.y;
        
        // Add a new page if we're running out of space
        if (yPos > 700) {
            doc.addPage();
            yPos = 50;
        }
    });
    
    // Recent activity
    doc.addPage();
    doc.fontSize(16)
       .text('Recent Activity', { underline: true })
       .moveDown(0.5);
    
    // Get the last 20 point records
    const recentActivity = allPoints.slice(0, 20);
    
    // Table headers
    yPos = doc.y;
    doc.font('Helvetica-Bold')
       .text('Date', 50, yPos)
       .text('Username', 150, yPos)
       .text('Points', 300, yPos)
       .moveDown(0.5);
    
    yPos = doc.y;
    doc.font('Helvetica');
    
    recentActivity.forEach((record) => {
        const date = new Date(record.last_updated).toLocaleDateString();
        
        doc.text(date, 50, yPos)
           .text(record.username || 'Unknown', 150, yPos)
           .text(record.points.toString(), 300, yPos)
           .moveDown(0.5);
        
        yPos = doc.y;
        
        // Add a new page if we're running out of space
        if (yPos > 700) {
            doc.addPage();
            yPos = 50;
        }
    });
    
    // Add some information about the report at the end
    doc.addPage();
    doc.fontSize(16)
       .text('About This Report', { underline: true })
       .moveDown(0.5);
    
    doc.fontSize(12)
       .text('This report was generated automatically by the Quiz Bot.')
       .moveDown(0.5)
       .text('It contains information about user participation and points earned in quizzes.')
       .moveDown(1)
       .text('For questions or support, please contact the bot administrator.');
    
    // Finalize the PDF
    doc.end();
    
    // Return a promise that resolves when the stream is finished
    return new Promise((resolve, reject) => {
        stream.on('finish', () => resolve(reportPath));
        stream.on('error', reject);
    });
}

// Command to generate a question using AI
bot.onText(/\/genquestion(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Check if user is admin
    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, "❌ Only admins can generate new questions.");
    }
    
    // Get topic if provided, otherwise use a general prompt
    const topic = match[1] ? match[1].trim() : "general knowledge";
    
    bot.sendMessage(chatId, `🤖 Generating a new quiz question about "${topic}"...`);
    bot.sendChatAction(chatId, 'typing');
    
    try {
        // Use our existing AI to generate a question
        const prompt = `Generate a single trivia question about ${topic}. 
        Format your response as a JSON object with these fields:
        - question_text: The question itself
        - correct_answer: The correct answer (keep it short)
        - message_text: A formatted version of the question for display
        
        Make sure the question is factually correct and has a clear, unambiguous answer.`;
        
        const aiResponse = await processWithAI(prompt);
        
        // Try to parse the JSON response
        let questionData;
        try {
            // Find JSON in the response (it might have extra text)
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                questionData = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error("No valid JSON found in response");
            }
            
            // Validate the parsed data
            if (!questionData.question_text || !questionData.correct_answer) {
                throw new Error("Missing required fields in the response");
            }
            
            // Make sure message_text exists, if not use question_text
            if (!questionData.message_text) {
                questionData.message_text = `Question: ${questionData.question_text}`;
            }
            
            // Save to database
            const db = await getDb();
            await db.run(
                'INSERT INTO questions (question_text, correct_answer, message_text) VALUES (?, ?, ?)',
                [questionData.question_text, questionData.correct_answer, questionData.message_text]
            );
            const result = await db.get('SELECT last_insert_rowid() as id');
            await db.close();
            
            // Show success message with preview
            const successMsg = `✅ Question created successfully! (ID: ${result.id})\n\n` +
                              `Question: ${questionData.question_text}\n` +
                              `Answer: ${questionData.correct_answer}`;
            
            bot.sendMessage(chatId, successMsg);
            
            // Ask if they want to add another one
            setTimeout(() => {
                bot.sendMessage(chatId, 
                    "Would you like to generate another question?\n" +
                    "Use /genquestion [topic] to specify a topic."
                );
            }, 1000);
            
        } catch (parseError) {
            console.error("Error parsing AI response:", parseError);
            bot.sendMessage(chatId, 
                "❌ Sorry, I couldn't create a proper question from the AI response.\n" +
                "Please try again or use a different topic."
            );
        }
    } catch (error) {
        console.error("Error generating question:", error);
        bot.sendMessage(chatId, "❌ Failed to generate question: " + error.message);
    }
});

// Command to export all questions to Excel
bot.onText(/\/exportquestions/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Check if user is admin
    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, "❌ Only admins can export questions.");
    }
    
    bot.sendMessage(chatId, "📊 Preparing Excel file with all questions...");
    
    try {
        // Create temp directory for exports if it doesn't exist
        const exportDir = path.join(__dirname, 'exports');
        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir);
        }
        
        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const excelPath = path.join(exportDir, `questions-${timestamp}.xlsx`);
        
        // Get all questions from database
        const db = await getDb();
        const questions = await db.all('SELECT * FROM questions ORDER BY question_id');
        await db.close();
        
        if (questions.length === 0) {
            return bot.sendMessage(chatId, "❌ No questions found in the database.");
        }
        
        // Create workbook and worksheet
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(questions);
        
        // Set column widths for better readability
        const colWidths = [
            { wch: 5 },    // id
            { wch: 50 },   // question_text
            { wch: 30 },   // correct_answer
            { wch: 60 }    // message_text
        ];
        worksheet['!cols'] = colWidths;
        
        // Add worksheet to workbook
        XLSX.utils.book_append_sheet(workbook, worksheet, "Questions");
        
        // Write to file
        XLSX.writeFile(workbook, excelPath);
        
        // Send the file
        await bot.sendDocument(chatId, excelPath, {
            caption: `📝 Exported ${questions.length} questions to Excel.`
        });
        
        // Clean up the file after sending
        fs.unlink(excelPath, (err) => {
            if (err) console.error('Error deleting temporary Excel file:', err);
        });
        
    } catch (error) {
        console.error("Error exporting questions:", error);
        bot.sendMessage(chatId, "❌ Failed to export questions: " + error.message);
    }
});

// Command to add new question manually
bot.onText(/\/addquestion/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Check if user is admin
    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, "❌ Only admins can add questions.");
    }
    
    // Start conversation for adding question
    bot.sendMessage(chatId, 
        "📝 Let's add a new question!\n\n" +
        "Please send me the question text first."
    );
    
    // Store user in question creation mode
    startedUsers.set(userId, {
        ...startedUsers.get(userId),
        addingQuestion: true,
        questionData: {}
    });
    
    // We'll handle the rest in the message listener
});

// Add this to the message listener to handle question creation conversation
// Inside your existing message listener, before the 'private chats' section

// Helper function to import question from Excel (for admin use)
async function importQuestionsFromExcel(filePath) {
    try {
        // Read Excel file
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);
        
        // Connect to database
        const db = await getDb();
        
        // Insert each question
        const results = {
            total: data.length,
            imported: 0,
            errors: []
        };
        
        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            
            try {
                // Check required fields
                if (!row.question_text || !row.correct_answer) {
                    results.errors.push({
                        row: i + 2, // +2 because Excel starts at 1 and there's a header row
                        error: "Missing required fields"
                    });
                    continue;
                }
                
                // Set message_text if not provided
                const message_text = row.message_text || `Question: ${row.question_text}`;
                
                // Insert into database
                await db.run(
                    'INSERT INTO questions (question_text, correct_answer, message_text) VALUES (?, ?, ?)',
                    [row.question_text, row.correct_answer, message_text]
                );
                
                results.imported++;
            } catch (error) {
                results.errors.push({
                    row: i + 2,
                    error: error.message
                });
            }
        }
        
        await db.close();
        
        // Clean up the file
        fs.unlink(filePath, err => {
            if (err) console.error('Error deleting temporary Excel file:', err);
        });
        
        return results;
    } catch (error) {
        console.error("Error importing questions:", error);
        throw error;
    }
}

// Add Excel file handling for question import
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Only process Excel files from admins
    if (!isAdmin(userId)) return;
    
    const document = msg.document;
    
    // Check if it's an Excel file
    if (document && (
        document.mime_type === 'application/vnd.ms-excel' ||
        document.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )) {
        bot.sendMessage(chatId, "📊 Detected Excel file. Would you like to import questions from this file?", {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Yes, import questions", callback_data: `import_${document.file_id}` },
                        { text: "❌ No", callback_data: "cancel_import" }
                    ]
                ]
            }
        });
    }
});

// Handle import confirmation
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
    // Handle import confirmation
    if (data.startsWith('import_') && isAdmin(userId)) {
        const fileId = data.substring('import_'.length);
        
        // Answer callback query to clear the loading state
        bot.answerCallbackQuery(callbackQuery.id);
        
        // Update message
        bot.editMessageText("📥 Downloading file and importing questions...", {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id
        });
        
        try {
            // Get file info
            const fileInfo = await bot.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
            
            // Create temp directory for imports if it doesn't exist
            const importDir = path.join(__dirname, 'imports');
            if (!fs.existsSync(importDir)) {
                fs.mkdirSync(importDir);
            }
            
            // Download file
            const filePath = path.join(importDir, `import-${Date.now()}.xlsx`);
            
            // Download file using HTTPS
            const https = require('https');
            const file = fs.createWriteStream(filePath);
            
            await new Promise((resolve, reject) => {
                https.get(fileUrl, response => {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });
                }).on('error', err => {
                    fs.unlink(filePath, () => {});
                    reject(err);
                });
            });
            
            // Import questions
            const results = await importQuestionsFromExcel(filePath);
            
            // Show results
            let message = `✅ Import completed!\n\n` +
                          `Total rows: ${results.total}\n` +
                          `Successfully imported: ${results.imported}\n` +
                          `Failed: ${results.errors.length}`;
            
            if (results.errors.length > 0) {
                message += `\n\nErrors:\n`;
                results.errors.slice(0, 5).forEach(err => {
                    message += `- Row ${err.row}: ${err.error}\n`;
                });
                
                if (results.errors.length > 5) {
                    message += `... and ${results.errors.length - 5} more errors.`;
                }
            }
            
            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id
            });
            
        } catch (error) {
            console.error("Error importing questions:", error);
            bot.editMessageText(`❌ Failed to import questions: ${error.message}`, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id
            });
        }
    } 
    else if (data === 'cancel_import') {
        // Answer callback query
        bot.answerCallbackQuery(callbackQuery.id);
        
        // Update message
        bot.editMessageText("❌ Import cancelled.", {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id
        });
    }
    else if (data === 'export_questions' && isAdmin(userId)) {
        // Answer callback query to clear the loading state
        bot.answerCallbackQuery(callbackQuery.id);
        
        // Call the export questions function directly
        try {
            // Create temp directory for exports if it doesn't exist
            const exportDir = path.join(__dirname, 'exports');
            if (!fs.existsSync(exportDir)) {
                fs.mkdirSync(exportDir);
            }
            
            // Generate filename with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const excelPath = path.join(exportDir, `questions-${timestamp}.xlsx`);
            
            // Get all questions from database
            const db = await getDb();
            const questions = await db.all('SELECT * FROM questions ORDER BY question_id');
            await db.close();
            
            if (questions.length === 0) {
                return bot.sendMessage(chatId, "❌ No questions found in the database.");
            }
            
            // Create workbook and worksheet
            const workbook = XLSX.utils.book_new();
            const worksheet = XLSX.utils.json_to_sheet(questions);
            
            // Set column widths for better readability
            const colWidths = [
                { wch: 5 },    // id
                { wch: 50 },   // question_text
                { wch: 10 },   // correct_answer
                { wch: 60 }    // message_text
            ];
            worksheet['!cols'] = colWidths;
            
            // Add worksheet to workbook
            XLSX.utils.book_append_sheet(workbook, worksheet, "Questions");
            
            // Write to file
            XLSX.writeFile(workbook, excelPath);
            
            // Send the file
            await bot.sendDocument(chatId, excelPath, {
                caption: `📝 Exported ${questions.length} questions to Excel.`
            });
            
            // Clean up the file after sending
            fs.unlink(excelPath, (err) => {
                if (err) console.error('Error deleting temporary Excel file:', err);
            });
        } catch (error) {
            console.error("Error exporting questions:", error);
            bot.sendMessage(chatId, "❌ Failed to export questions: " + error.message);
        }
    }
    // ...handle other callback queries...
});

// Command to generate multiple questions in bulk using AI
bot.onText(/\/genbulkquestion(?:\s+(\d+))?(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Check if user is admin
    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, "❌ Only admins can generate questions.");
    }
    
    // Get count (default: 5) and topic (default: general knowledge)
    const count = match[1] ? parseInt(match[1]) : 5;
    const topic = match[2] ? match[2].trim() : "general knowledge";
    
    // Validate count
    if (count < 1 || count > 30) {
        return bot.sendMessage(chatId, "Please specify a number between 1 and 10 for bulk generation.");
    }
    
    bot.sendMessage(chatId, `🤖 Generating ${count} unique quiz questions about "${topic}"...`);
    bot.sendChatAction(chatId, 'typing');
    
    try {
        // Use our existing AI to generate multiple questions
        const prompt = `Generate ${count} unique trivia questions about ${topic}. 
        Each question should have 4 multiple-choice options (A, B, C, D) with only one correct answer.
        
        Format your response as a JSON array of objects with these fields for each question:
        - question_text: The question itself including the multiple-choice options
        - correct_answer: The single correct answer (just the letter A, B, C, or D)
        - message_text: A formatted version of the question for display (include the options)
        
        Make sure the questions are factually correct and have clear, unambiguous answers.
        Ensure all questions are different from each other.`;
        
        const aiResponse = await processWithAI(prompt);
        
        // Try to parse the JSON response
        let questionArray;
        try {
            // Find JSON in the response (it might have extra text)
            const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                questionArray = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error("No valid JSON array found in response");
            }
            
            // Validate the parsed data
            if (!Array.isArray(questionArray) || questionArray.length === 0) {
                throw new Error("Invalid JSON format: expected an array of questions");
            }
            
            // Connect to database
            const db = await getDb();
            const successfulQuestions = [];
            const failedQuestions = [];
            
            // Process each question
            for (const questionData of questionArray) {
                // Validate question data
                if (!questionData.question_text || !questionData.correct_answer) {
                    failedQuestions.push("Missing required fields");
                    continue;
                }
                
                // Make sure message_text exists, if not use question_text
                if (!questionData.message_text) {
                    questionData.message_text = questionData.question_text;
                }
                
                try {
                    // Save to database
                    await db.run(
                        'INSERT INTO questions (question_text, correct_answer, message_text) VALUES (?, ?, ?)',
                        [questionData.question_text, questionData.correct_answer, questionData.message_text]
                    );
                    const result = await db.get('SELECT last_insert_rowid() as id');
                    
                    successfulQuestions.push({
                        id: result.id,
                        question: questionData.question_text.split('\n')[0], // First line only for preview
                        answer: questionData.correct_answer
                    });
                } catch (error) {
                    console.error("Error saving question:", error);
                    failedQuestions.push(error.message);
                }
            }
            
            await db.close();
            
            // Create success message
            let successMsg;
            if (successfulQuestions.length > 0) {
                successMsg = `✅ Successfully generated ${successfulQuestions.length}/${questionArray.length} questions!\n\n`;
                
                // Add sample of generated questions (max 3)
                successMsg += "Examples:\n";
                const sampleQuestions = successfulQuestions.slice(0, 3);
                sampleQuestions.forEach((q, index) => {
                    successMsg += `${index + 1}. ID ${q.id}: "${q.question}..." (Answer: ${q.answer})\n`;
                });
                
                if (successfulQuestions.length > 3) {
                    successMsg += `...and ${successfulQuestions.length - 3} more questions.\n\n`;
                }
                
                // Export option
                successMsg += "Would you like to export all your questions to Excel?";
                
                bot.sendMessage(chatId, successMsg, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "📊 Export All Questions", callback_data: "export_questions" }]
                        ]
                    }
                });
            } else {
                bot.sendMessage(chatId, "❌ Failed to generate any valid questions. Please try again.");
            }
            
        } catch (parseError) {
            console.error("Error parsing AI response:", parseError);
            bot.sendMessage(chatId, 
                "❌ Sorry, I couldn't create proper questions from the AI response.\n" +
                "Please try again or use a different topic."
            );
        }
    } catch (error) {
        console.error("Error generating questions:", error);
        bot.sendMessage(chatId, "❌ Failed to generate questions: " + error.message);
    }
});

// ...existing code...

console.log("Telegram Bot is running with SQLite database: " + dbPath);
