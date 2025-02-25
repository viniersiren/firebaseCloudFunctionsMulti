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


// Handle moderation alerts from posts collection
exports.sendModerationAlerts = onDocumentUpdated(
    "posts/{postId}",
    async (event) => {
        try {
            const beforeData = event.data.before.data();
            const afterData = event.data.after.data();

            if (afterData.removedAt !=nil) {
                logger.log(`Post ${event.params.postId} already removed`);
                return;
            }

            // Threshold checks
            const unfairnessBefore = beforeData.unfairness || 0;
            const unfairnessAfter = afterData.unfairness || 0;
            const inappropriateBefore = beforeData.inapropriateCount || 0;
            const inappropriateAfter = afterData.inapropriateCount || 0;

            // Determine which thresholds were crossed
            const reasons = [];
            if (unfairnessAfter >= 6 && unfairnessBefore < 6) reasons.push('unfair');
            if (inappropriateAfter >= 3 && inappropriateBefore < 3) reasons.push('inapropriate');

            if (reasons.length > 0) {
                await handlePostRemoval(event.params.postId, afterData, reasons);
            }
        } catch (error) {
            logger.error("Error processing moderation alerts:", error);
        }
    }
);

async function handlePostRemoval(postId, postData, reasons) {
    try {
        const postIdString = String(postId);
        const posterId = postData.poster;

        // Mark post as removed in Firestore
        const postRef = db.collection("posts").doc(postIdString);
        await postRef.update({
            removedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Get poster details
        const posterRef = db.collection("users").doc(posterId);
        const posterSnapshot = await posterRef.get();
        
        if (!posterSnapshot.exists) {
            logger.error(`Poster ${posterId} not found`);
            return;
        }

        const posterData = posterSnapshot.data();
        const fcmToken = posterData.fcmToken;

        if (!fcmToken) {
            logger.error(`No FCM token for poster ${posterId}`);
            return;
        }

        // Build notification messages
        const reasonMessage = buildReasonMessage(reasons);
        const userMessage = createUserMessage(postIdString, reasonMessage, fcmToken, reasons);
        const adminMessage = createAdminMessage(postIdString, reasonMessage, reasons);

        // Send notifications
        await admin.messaging().send(userMessage);
        await admin.messaging().send(adminMessage);
        logger.log(`Post ${postIdString} removed and notifications sent`);

    } catch (error) {
        logger.error("Error handling post removal:", error);
    }
}

function buildReasonMessage(reasons) {
    if (reasons.includes('unfair') && reasons.includes('inappropriate')) {
        return "being flagged as both unfair and inappropriate";
    }
    return reasons.includes('unfair') ? 
        "receiving multiple unfairness flags" : 
        "containing inappropriate content";
}

function createUserMessage(postId, reasonMessage, fcmToken, reasons) { // Add reasons parameter
    return {
        notification: {
            title: "Post Removed",
            body: `Your post was removed for ${reasonMessage}.`,
        },
        token: fcmToken,
        data: {
            postId: postId,
            type: 'post_removed',
            reasons: reasons.join(',') // Now has access to reasons
        }
    };
}

function createAdminMessage(postId, reasonMessage, reasons) { // Add reasons parameter
    return {
        notification: {
            title: "Post Removed",
            body: `Post ${postId} removed for ${reasonMessage}`,
        },
        topic: "admin_alerts",
        data: {
            postId: postId,
            reasons: reasons.join(','), // Now has access to reasons
            action: 'review_required'
        }
    };
}
exports.handlePostNotifications = onDocumentUpdated(
    "users/{userId}",
    async (event) => {
        try {
            const beforeData = event.data.before.data();
            const afterData = event.data.after.data();

            // Process Matched Posts
            const previousMatched = beforeData.matchedPosts || [];
            const currentMatched = afterData.matchedPosts || [];
            const newMatched = currentMatched.filter(id => !previousMatched.includes(id));
            
            // Process Hunted Posts (followingPosts)
            const previousHunted = beforeData.followingPosts || [];
            const currentHunted = afterData.followingPosts || [];
            const newHunted = currentHunted.filter(id => !previousHunted.includes(id));

            // Handle matched posts notifications
            await processPostType(newMatched, "matched", event);

            // Handle hunted posts notifications
            await processPostType(newHunted, "hunted", event);

        } catch (error) {
            logger.error("Error processing post notifications:", error);
        }
    }
);

async function processPostType(postIds, type, event) {
    if (postIds.length === 0) {
        logger.log(`No new ${type} posts found`);
        return;
    }

    for (const postId of postIds) {
        const postRef = db.collection("posts").doc(postId);
        const postSnapshot = await postRef.get();

        if (!postSnapshot.exists) {
            logger.error(`${type} Post ${postId} not found`);
            continue;
        }

        const postData = postSnapshot.data();
        const posterId = postData.poster;
        const posterRef = db.collection("users").doc(posterId);
        const posterSnapshot = await posterRef.get();

        if (!posterSnapshot.exists) {
            logger.error(`Poster ${posterId} not found for ${type} post`);
            continue;
        }

        const posterData = posterSnapshot.data();
        const fcmToken = posterData.fcmToken;

        if (!fcmToken) {
            logger.error(`No FCM token for ${type} post recipient`);
            continue;
        }

        if (type === "matched") {
            await sendMatchNotification(postData, posterData, postId, fcmToken);
        } else if (type === "hunted") {
            await sendHuntNotification(event, postId, posterData, fcmToken);
        }
    }
}

async function sendMatchNotification(postData, posterData, postId, fcmToken) {
    const username = posterData.username || "Someone";
    const city = postData.city || "your area";
    const currentTime = new Date().toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit' 
    });

    const message = {
        notification: {
            title: "📬 New Post Match!",
            body: `${username} matched your post in ${city} at ${currentTime}`,
        },
        token: fcmToken
    };

    await admin.messaging().send(message);
    logger.log(`Match notification sent for post ${postId}`);
}

async function sendHuntNotification(event, postId, posterData, fcmToken) {
    const hunterData = event.data.after.data();
    const hunterName = hunterData.username || "Someone";
    const postIdString = String(postId);

    const message = {
        notification: {
            title: "🎯 Post Hunted!",
            body: `${hunterName} hunted your post`,
        },
        token: fcmToken,
        data: {
            postId: postIdString,
            type: 'post_hunted'
        }
    };

    await admin.messaging().send(message);
    logger.log(`Hunt notification sent for post ${postIdString}`);
}

//firebase use to see current project
//firebase use --add to add a new project


/* ------DEPRECATED---------
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
                const username = posterData.username; // Assuming 'username' field exists in the user document
                const postCity = postData.city || "your area"; 
                if (!fcmToken) {
                    logger.error(`No FCM token for user ${posterId}`);
                    continue;
                }

                // Create notification message
                const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const message = {
                    notification: {
                        title: "📬 New Post Match!",
                        body: `${username} matched your post in ${postCity} at ${currentTime}`,
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
exports.sendHuntedNotification = onDocumentUpdated(
    "users/{userId}",
    async (event) => {
        try {
            const beforeData = event.data.before.data();
            const afterData = event.data.after.data();

            // Get huntedPosts arrays before and after
            const previousHuntedPosts = beforeData.followingPosts || [];
            const currentHuntedPosts = afterData.followingPosts || [];

            // Find newly added post IDs
            const newPostIds = currentHuntedPosts.filter(
                (postId) => !previousHuntedPosts.includes(postId)
            );

            if (newPostIds.length === 0) {
                logger.log("No new hunted posts added");
                return;
            }

            // Process each new hunted post
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
                const hunterData = event.data.after.data();
                const hunterName = hunterData.username || "Someone";

                if (!fcmToken) {
                    logger.error(`No FCM token for user ${posterId}`);
                    continue;
                }

                // Create notification message
                const message = {
                    notification: {
                        title: "🎯 Post Hunted!",
                        body: `${hunterName} hunted your post`,
                    },
                    token: fcmToken,
                    data: {
                        postId: postId,
                        type: 'post_hunted'
                    }
                };

                await admin.messaging().send(message);
                logger.log(`Hunt notification sent to ${posterId} for post ${postId}`);
            }
        } catch (error) {
            logger.error("Error processing hunted post notification:", error);
        }
    }
);


*/
