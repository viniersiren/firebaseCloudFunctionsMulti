/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Cloud Function to process a sweepstake every 5 minutes
exports.processSweepstake = onSchedule("every 5 minutes", async (event) => {
  const sweepstakesRef = db.collection("sweepstakes");
  const now = new Date();
  console.log(now)

  try {
    // Query sweepstakes that have ended but are not completed or being processed
    const querySnapshot = await sweepstakesRef
      .where("endDate", "<=", now)
      .where("isCompleted", "==", false)
      .where("isProcessing", "==", false)
      .limit(1) // Process one sweepstake at a time
      .get();

    if (querySnapshot.empty) {
      console.log("No sweepstakes to process.");
      return null;
    }

    // Get the first sweepstake to process
    const sweepstakeDoc = querySnapshot.docs[0];
    const sweepstakeId = sweepstakeDoc.id;
    const sweepstakeData = sweepstakeDoc.data();

    console.log(`Processing sweepstake: ${sweepstakeId}`);
    console.log(sweepstakeData);

    // Start processing by setting `isProcessing` to true
    await sweepstakesRef.doc(sweepstakeId).update({ isProcessing: true });

    // Determine the winner
    const enteredUsers = sweepstakeData.enteredUsers || [];
    let weightedUsers = [];
    for (const user of enteredUsers) {
      for (let i = 0; i < user.entryCount; i++) {
        weightedUsers.push(user.userId);
      }
    }

    if (weightedUsers.length === 0) {
      console.log(`No participants in sweepstake: ${sweepstakeId}`);
      await sweepstakesRef.doc(sweepstakeId).update({
        isCompleted: true,
        isProcessing: false,
        winner: null,
      });
      return null;
    }

    const winnerId = weightedUsers[Math.floor(Math.random() * weightedUsers.length)];
    await sweepstakeDoc.ref.update({ //save winner to sweepstake
      isCompleted: true,
      isProcessing: false,
      winner: winnerId, // Save the winner's ID
    });
    console.log(`Winner determined: ${winnerId}`);

    // Update sweepstake document with the winner and mark as completed
    await sweepstakesRef.doc(sweepstakeId).update({
      winner: winnerId,
      isCompleted: true,
      isProcessing: false,
    });

    console.log(`Sweepstake ${sweepstakeId} processed successfully.`);

    // Send a push notification to the winner
    const userRef = db.collection("users").doc(winnerId);
    const userDoc = await userRef.get();
    await userRef.update({ //update winner array for the user
      wins: admin.firestore.FieldValue.arrayUnion(sweepstakeId),
    });

    console.log(`Sweepstake ${sweepstakeId} added to winner's wins array: ${winnerId}`);

    if (userDoc.exists) {
      const userData = userDoc.data();
      const fcmToken = userData.fcmToken;

      console.log(`Retrieved FCM Token for user ${winnerId}: ${fcmToken}`);

      if (fcmToken) {
        await sendPushNotification(fcmToken, sweepstakeData.title); //send push notif to user
      } else {
        console.log(`FCM Token not found for user ${winnerId}`);
      }
    } else {
      console.log(`User document for ${winnerId} not found.`);
    }

    return null;
  } catch (error) {
    console.error("Error processing sweepstake:", error);
    return null;
  }
});

// Helper function to send push notification
async function sendPushNotification(fcmToken, sweepstakeTitle) {
  const message = {
    notification: {
      title: "Congratulations!",
      body: `You've won the sweepstake: ${sweepstakeTitle}! 🎉`,
    },
    token: fcmToken,
  };

  try {
    console.log(`Sending push notification to token: ${fcmToken}`);
    const response = await admin.messaging().send(message);
    console.log("Push notification sent successfully:", response);
  } catch (error) {
    console.error("Error sending push notification:", error);
  }
}
