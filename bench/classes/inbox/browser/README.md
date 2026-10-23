# inbox/browser

Drop ONE JSON result file per scored run here, following the
`mochi-class-result` schema in bench/classes/README.md ("The result-file
contract"). The scorecard (`mochi bench classes`) ingests the file with
the greatest `ts`. Until the first valid file lands, this class reports
UNMEASURED — that is the honest state, not an error.
