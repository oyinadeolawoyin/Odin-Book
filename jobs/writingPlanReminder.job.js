const cron = require("node-cron");
const prisma = require("../config/prismaClient");
const { notifyUser } = require("../services/notificationService");
const { getCurrentTimeInTimezone, timeToMinutes } = require("../utilis/getTimezones");

const dayMap = {
  0: { goal: "sundayGoal", time: "sundayTime", label: "Sunday" },
  1: { goal: "mondayGoal", time: "mondayTime", label: "Monday" },
  2: { goal: "tuesdayGoal", time: "tuesdayTime", label: "Tuesday" },
  3: { goal: "wednesdayGoal", time: "wednesdayTime", label: "Wednesday" },
  4: { goal: "thursdayGoal", time: "thursdayTime", label: "Thursday" },
  5: { goal: "fridayGoal", time: "fridayTime", label: "Friday" },
  6: { goal: "saturdayGoal", time: "saturdayTime", label: "Saturday" }
};

function getMotivationalMessage(user, goal, currentTime) {
  const username = user.username;
  const goalText = goal > 0 ? `${goal} words` : 'something';
  
  // Parse time (assumes format "HH:mm")
  const [hours, minutes] = currentTime.split(':').map(Number);
  
  // Determine time of day
  let timeOfDay;
  let greeting;
  
  if (hours >= 5 && hours < 12) {
    timeOfDay = 'morning';
    greeting = 'Morning';
  } else if (hours >= 12 && hours < 17) {
    timeOfDay = 'afternoon';
    greeting = 'Hey';
  } else if (hours >= 17 && hours < 21) {
    timeOfDay = 'evening';
    greeting = 'Evening';
  } else {
    timeOfDay = 'night';
    greeting = 'Hey';
  }
  
  // Time-specific messages
  const messagesByTime = {
    morning: [
      `${greeting}, ${username}! ☕\n\nYou wanted to write this morning.\n\nWant to start a quick sprint before your day gets busy?\n\n(Even 10 minutes counts.)`,
      
      `Good morning, ${username}! 🌅\n\nFresh day, fresh page.\n\nReady to write ${goalText}?\n\n(No pressure if not - I'll be here later too.)`,
      
      `${greeting} ${username} 👋\n\nYou set this morning as writing time.\n\nEven 15 minutes before coffee kicks in counts.\n\nWant to try?`,
      
      `${username}, morning writing time 🖋️\n\nYour brain is fresh. Want to capture some words before the day starts?\n\n(Messy drafts welcome.)`
    ],
    
    afternoon: [
      `${greeting} ${username}!\n\nAfternoon writing break? ☕\n\nYou planned to write ${goalText} today.\n\nWant to spend 15 minutes on it?`,
      
      `${username}, ready for an afternoon sprint?\n\nOther writers are here too. You're not alone.\n\nEven 10 minutes counts. 🌱`,
      
      `${greeting} ${username} 👋\n\nMidday check-in: want to write?\n\nNo pressure - even one paragraph is progress.\n\n[Start a sprint]`,
      
      `Afternoon, ${username}!\n\nYou wanted to write today.\n\nPerfect time for a quick 20-minute sprint?\n\n(If not now, that's okay too.)`
    ],
    
    evening: [
      `${greeting}, ${username}! 🌙\n\nEnd-of-day writing session?\n\nYou planned to write ${goalText} today.\n\nWant to unwind with a sprint?`,
      
      `${username}, evening writing time 🖋️\n\nNo rush. No pressure.\n\nJust you, your words, and 25 minutes.\n\nReady?`,
      
      `${greeting} ${username}!\n\nBefore you close the day - want to write?\n\nEven 5 minutes counts as showing up.\n\n(Or skip if you're tired - that's valid too.)`,
      
      `${username}, this is your gentle reminder 🌱\n\nYou set tonight for writing.\n\nEven one sentence is progress.\n\nWant to give it a try?`
    ],
    
    night: [
      `${greeting} ${username}, night owl! 🦉\n\nLate-night writing session?\n\nYou wanted to write ${goalText} today.\n\nWant to try before bed?`,
      
      `${username}, it's late but... want to write? 🌙\n\nNo pressure at all.\n\nEven 10 minutes before sleep counts.\n\n(Or save it for tomorrow - totally fine.)`,
      
      `${greeting} ${username}!\n\nI know it's late.\n\nIf you're up for it: quick 15-minute sprint?\n\nIf not: tomorrow's a new day. ❤️`,
      
      `${username}, late-night reminder 🌛\n\nYou set this time for writing.\n\nEven capturing a few thoughts counts.\n\nWant to try? (Or rest - that's important too.)`
    ]
  };
  
  // Get messages for current time of day
  const relevantMessages = messagesByTime[timeOfDay];
  
  // Return random message from that time period
  return relevantMessages[Math.floor(Math.random() * relevantMessages.length)];
}

cron.schedule("*/5 * * * *", async () => {
  try {
    const plans = await prisma.writingPlan.findMany({
      include: { user: true }
    });

    for (const plan of plans) {
      const user = plan.user;
      if (!user?.timezone) continue;

      const now = new Date();
      const weekdayIndex = new Date(
        now.toLocaleString("en-US", { timeZone: user.timezone })
      ).getDay();

      const { goal, time, label } = dayMap[weekdayIndex];
      if (!plan[goal] || !plan[time]) continue;

      const currentTime = getCurrentTimeInTimezone(user.timezone); // "HH:mm"

      const diff = Math.abs(
        timeToMinutes(currentTime) - timeToMinutes(plan[time])
      );

      // ±2 minutes tolerance
      if (diff > 2) continue;

      // Normalize date
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Check if already notified
      const alreadySent = await prisma.sentReminder.findUnique({
        where: {
          userId_date_day: {
            userId: user.id,
            date: today,
            day: label
          }
        }
      });

      if (alreadySent) continue;

      // ✅ Pass currentTime to message generator
      const message = getMotivationalMessage(user, plan[goal], currentTime);

      await notifyUser(user, message, "/dashboard/writing-plan");

      // Record reminder
      await prisma.sentReminder.create({
        data: {
          userId: user.id,
          date: today,
          day: label
        }
      });
    }
  } catch (error) {
    console.error("Writing plan reminder job failed:", error);
  }
});