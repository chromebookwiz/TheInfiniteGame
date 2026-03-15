export const STARTING_CONDITIONS = [
  "You wake inside a lighthouse whose beam only reveals places that no longer exist.",
  "A city-sized train arrives once every century, and tonight it opens its doors for you.",
  "Your village elects a new protector by throwing names into a volcano, and the volcano chose you.",
  "At the bottom of the ocean, a royal court asks you to solve a murder before sunrise reaches the surface.",
  "A talking storm settles above your home and refuses to move until you grant it a single favor.",
  "You inherit a bookstore where every unpaid debt is written in prophecy instead of money.",
  "The moon sends you a handwritten apology and invites you to a duel.",
  "A ruined arcade cabinet boots up with your name already in the high-score table and a map to buried treasure.",
  "The last dragon opens a detective agency and hires you as its only human partner.",
  "A haunted space station transmits your voice asking for help from exactly twelve minutes in the future.",
  "Your shadow is arrested for crimes you have not committed yet.",
  "A desert caravan trades only in memories, and someone has stolen your happiest day.",
  "An ancient forest crowns a new monarch every spring, and the roots have chosen you against your will.",
  "You are the first witness when a god quietly resigns.",
  "A tiny kingdom appears overnight inside your apartment walls and demands diplomatic recognition.",
  "The world ends tomorrow, but only your neighborhood received the schedule in advance.",
  "A pirate radio station begins broadcasting side quests directly into your dreams.",
  "An underground city mistakes you for the missing heir to a clockwork throne.",
  "You pull a sword from a lake, and the lake politely asks for it back after one quest.",
  "A monster-hunting guild rejects your application, then immediately needs you to save them.",
  "The museum where you work discovers one exhibit is still alive and wants to go home.",
  "A cursed hotel adds a new floor every midnight, and tonight you have the master key.",
  "Your hometown festival includes a secret tournament where losers become legends.",
  "A benevolent AI the size of a cathedral declares your tiny problem its top priority."
] as const;

export function pickRandomStartingCondition(): string {
  const index = Math.floor(Math.random() * STARTING_CONDITIONS.length);
  return STARTING_CONDITIONS[index];
}
