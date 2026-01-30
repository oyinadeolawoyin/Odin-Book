const prisma = require("../config/prismaClient");

async function createWritingPlan(userId, mondayGoal, tuesdayGoal, wednesdayGoal, thursdayGoal, fridayGoal, saturdayGoal, sundayGoal, mondayTime, tuesdayTime, wednesdayTime, thursdayTime, fridayTime, saturdayTime, sundayTime) {
    return await prisma.writingPlan.create({
        data: {
            mondayGoal,
            tuesdayGoal,
            wednesdayGoal,
            thursdayGoal,
            fridayGoal,
            saturdayGoal,
            sundayGoal,
            mondayTime,
            tuesdayTime,
            wednesdayTime,
            thursdayTime,
            fridayTime,
            saturdayTime,
            sundayTime,
            userId
        }
    });
}

async function updateWritingPlan(planId, mondayGoal, tuesdayGoal, wednesdayGoal, thursdayGoal, fridayGoal, saturdayGoal, sundayGoal, mondayTime, tuesdayTime, wednesdayTime, thursdayTime, fridayTime, saturdayTime, sundayTime) {
    return await prisma.writingPlan.update({
        where: { id: planId },
        data: {
            mondayGoal,
            tuesdayGoal,
            wednesdayGoal,
            thursdayGoal,
            fridayGoal,
            saturdayGoal,
            sundayGoal,
            mondayTime,
            tuesdayTime,
            wednesdayTime,
            thursdayTime,
            fridayTime,
            saturdayTime,
            sundayTime
        }
    });
}

async function fetchWritingPlan(userId) {
    return await prisma.writingPlan.findUnique({
        where: { userId }
    });
}

module.exports = {
    createWritingPlan,
    updateWritingPlan,
    fetchWritingPlan
}