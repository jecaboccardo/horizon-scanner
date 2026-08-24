-- SMS = 0 designates non-empirical work (Review, Theoretical).
-- These were previously SMS=1, which conflated "weak empirical" with "non-empirical".
-- SMS=0 papers are admissible by default but excluded from rigor filters >=1.

UPDATE works
SET sms_level = 0
WHERE methodology_design IN ('Review', 'Theoretical')
  AND (sms_level IS NULL OR sms_level = 1);
