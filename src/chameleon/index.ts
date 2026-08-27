/**
 * Lazy Chameleon Architecture Suite
 * 
 * In-harness cellular MoE synthesis, test-time compute stalling,
 * task classification, and token saving.
 */

export * from './task-classifier.js';
export * from './adaptive-moe.js';
export * from './dense-dataset-synthesizer.js';
export * from './token-saver.js';
export { ChameleonEngine, type EnhanceOptions, type EnhanceResult, type ChameleonMode, type StallStrategy } from '../cognitive/chameleon.js';
