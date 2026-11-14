"""Experimental end-to-end acoustic-to-waveform composition for MEHRAN SVS.

This composes untrained/trainable network definitions. It is not a production
inference runtime and must not be exposed as generation-ready without trained
weights, quality evaluation, and output verification.
"""
from __future__ import annotations

from model_architecture import SingingNetworkConfig, build_singing_model
from waveform_decoder import WaveformDecoderConfig, build_waveform_decoder


def build_singing_pipeline(
    acoustic_config: SingingNetworkConfig | None = None,
    decoder_config: WaveformDecoderConfig | None = None,
):
    """Build a phoneme/MIDI -> acoustic prediction -> waveform composition."""
    try:
        import torch
        from torch import nn
    except ImportError as exc:
        raise RuntimeError("PyTorch is required; install training-requirements.txt") from exc

    acoustic_cfg = (acoustic_config or SingingNetworkConfig()).validate()
    decoder_cfg = (decoder_config or WaveformDecoderConfig()).validate()
    if acoustic_cfg.mel_bins != decoder_cfg.mel_bins:
        raise ValueError("acoustic and waveform decoder mel_bins must match")

    class MehranSingingPipeline(nn.Module):
        def __init__(self):
            super().__init__()
            self.acoustic_model = build_singing_model(acoustic_cfg)
            self.waveform_decoder = build_waveform_decoder(decoder_cfg)
            self.sample_rate = decoder_cfg.sample_rate
            self.hop_length = decoder_cfg.hop_length

        def forward(
            self,
            phoneme_ids,
            note_ids,
            conditioning_f0_hz,
            conditioning_voicing_mask,
            conditioning_energy,
            valid_frame_mask,
            speaker_reference_log_mel,
            speaker_reference_frame_mask,
        ):
            if speaker_reference_log_mel is None or speaker_reference_frame_mask is None:
                raise ValueError("a separate speaker reference and frame mask are required")
            acoustic = self.acoustic_model(
                phoneme_ids,
                note_ids,
                conditioning_f0_hz,
                conditioning_voicing_mask,
                conditioning_energy,
                valid_frame_mask,
                speaker_reference_log_mel,
                speaker_reference_frame_mask,
            )
            waveform = self.waveform_decoder(
                acoustic["log_mel"],
                acoustic["f0_hz"],
                torch.sigmoid(acoustic["voicing_logits"]),
                acoustic["log_rms"],
                speaker_reference_log_mel,
                speaker_reference_frame_mask,
            )
            frame_lengths = valid_frame_mask.to(torch.long).sum(dim=1)
            return {
                "waveform": waveform,
                "waveform_sample_lengths": frame_lengths * self.hop_length,
                "sample_rate": self.sample_rate,
                "acoustic": acoustic,
            }

    return MehranSingingPipeline()
