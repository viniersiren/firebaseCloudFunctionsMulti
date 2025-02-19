/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Send notification when a post is added to user's matchedPosts
exports.sendMatchedNotification = onDocumentUpdated(
    "users/{userId}",
    async (event) => {
        try {
            const beforeData = event.data.before.data();
            const afterData = event.data.after.data();

            // Get matchedPosts arrays before and after
            const previousMatchedPosts = beforeData.matchedPosts || [];
            const currentMatchedPosts = afterData.matchedPosts || [];

            // Find newly added post IDs
            const newPostIds = currentMatchedPosts.filter(
                (postId) => !previousMatchedPosts.includes(postId)
            );

            if (newPostIds.length === 0) {
                logger.log("No new matched posts added");
                return;
            }

            // Process each new matched post
            for (const postId of newPostIds) {
                const postRef = db.collection("posts").doc(postId);
                const postSnapshot = await postRef.get();

                if (!postSnapshot.exists) {
                    logger.error(`Post ${postId} not found`);
                    continue;
                }

                const postData = postSnapshot.data();
                const posterId = postData.poster;

                // Get poster's FCM token
                const posterRef = db.collection("users").doc(posterId);
                const posterSnapshot = await posterRef.get();

                if (!posterSnapshot.exists) {
                    logger.error(`User ${posterId} not found`);
                    continue;
                }

                const posterData = posterSnapshot.data();
                const fcmToken = posterData.fcmToken;

                if (!fcmToken) {
                    logger.error(`No FCM token for user ${posterId}`);
                    continue;
                }

                // Create notification message
                const currentTime = new Date().toLocaleString();
                const message = {
                    notification: {
                        title: "📬 New Post Match!",
                        body: `Your post was matched at ${currentTime}`,
                    },
                    token: fcmToken,
                };

                // Send notification
                await admin.messaging().send(message);
                logger.log(`Notification sent to ${posterId} for post ${postId}`);
            }
        } catch (error) {
            logger.error("Error processing matched post notification:", error);
        }
    }
);

//firebase use to see current project
//firebase use --add to add a new project