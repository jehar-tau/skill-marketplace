-- Asked during the guided "add a business" flow: has the person done this before,
-- and a few words about it in their own language. Private to the owner, like proofs.
ALTER TABLE capabilities
  ADD COLUMN experience text CHECK (experience IN ('business', 'informal', 'new')),
  ADD COLUMN experience_note text CHECK (char_length(experience_note) <= 500);
