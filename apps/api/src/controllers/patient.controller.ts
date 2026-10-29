import { Body, Controller, Delete, Get, Patch, Put, Headers, HttpCode, Inject, Param, Post, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ValidationError } from '@shared/errors/app-error';
import { ApiService } from '../application/api.service';
import { PatientPermissionGuard } from '../auth/patient-permission.guard';
import { BearerPrincipalGuard, RequestPrincipal } from '../auth/bearer-principal.guard';
import { Principal } from '../auth/principal.decorator';
import { ProblemDetailsFilter } from '../common/problem.filter';
import type { NotificationHistoryRow } from '@infra/db/postgres-notification-history.repository';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import type { DashboardHistoryResponse } from '@modules/dashboard/application/dashboard-history';
import type { DashboardTimeInRangeResponse } from '@modules/dashboard/application/dashboard-time-in-range';

@Controller('/v1/patients/:patientId')
@UseGuards(BearerPrincipalGuard, PatientPermissionGuard)
@UseFilters(ProblemDetailsFilter)
export class PatientController {
  constructor(@Inject(ApiService) private readonly apiService: ApiService) {}

  @Get('capabilities')
  async getCapabilities(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<Record<string, unknown>> {
    return this.apiService.getCapabilities(principal, patientId);
  }

  @Get('remote-control/trio')
  async getTrioRemoteTarget(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<Record<string, unknown>> {
    return this.apiService.getTrioRemoteTarget(principal, patientId);
  }

  @Get('remote-control/loop')
  async getLoopRemoteTarget(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<Record<string, unknown>> {
    return this.apiService.getLoopRemoteTarget(principal, patientId);
  }

  @Get('remote-commands/preview')
  async previewRemoteCommand(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Query('carbs_g') carbs = '0',
    @Query('insulin_u') insulin: string | undefined,
    @Query('bolus_step') step = '0.05',
    @Query('meal_in_minutes') mealIn: string | undefined,
    @Query('proposal_id') proposalId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const carbsG = Number(carbs);
    const insulinU = insulin === undefined || insulin === '' ? null : Number(insulin);
    const mealInMinutes = mealIn === undefined || mealIn === '' ? null : Number(mealIn);
    if (!Number.isFinite(carbsG) || (insulinU !== null && !Number.isFinite(insulinU))) throw new ValidationError('carbs_g and insulin_u must be numbers');
    if (mealInMinutes !== null && (!Number.isInteger(mealInMinutes) || mealInMinutes < 0 || mealInMinutes > 60)) throw new ValidationError('meal_in_minutes must be 0–60');
    return { ...(await this.apiService.previewRemoteCommand(principal, patientId, { carbs_g: carbsG, insulin_u: insulinU, bolus_step: Number(step), meal_in_minutes: mealInMinutes, proposal_id: proposalId?.trim() || null })) };
  }

  @Get('remote-commands')
  async listRemoteCommands(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Query('limit') limit = '20'): Promise<Record<string, unknown>> {
    return this.apiService.listRemoteCommands(principal, patientId, Number(limit));
  }

  @Post('remote-commands')
  async authorizeRemoteCommand(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.apiService.authorizeRemoteCommand(principal, patientId, body as never);
  }

  @Get('remote-commands/:commandId')
  async getRemoteCommand(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('commandId') commandId: string): Promise<Record<string, unknown>> {
    return this.apiService.getRemoteCommand(principal, patientId, commandId);
  }

  @Post('remote-commands/:commandId/sent')
  @HttpCode(200)
  async reportRemoteCommandSent(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('commandId') commandId: string, @Body() body: { accepted?: unknown; message?: unknown }): Promise<Record<string, unknown>> {
    return this.apiService.reportRemoteCommandSent(principal, patientId, commandId, body);
  }

  @Post('remote-commands/:commandId/reply')
  @HttpCode(200)
  async reportRemoteCommandReply(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('commandId') commandId: string, @Body() body: { success?: unknown; message?: unknown; step?: unknown }): Promise<Record<string, unknown>> {
    return this.apiService.reportRemoteCommandReply(principal, patientId, commandId, body);
  }

  @Get('dashboard')
  async getDashboard(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<DashboardResponse> {
    return this.apiService.getDashboard(principal, patientId);
  }

  @Get('dashboard/history')
  async getDashboardHistory(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): Promise<DashboardHistoryResponse> {
    return this.apiService.getDashboardHistory(principal, patientId, { from, to });
  }

  @Get('dashboard/time-in-range')
  async getDashboardTimeInRange(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Query('days') days: string | undefined,
  ): Promise<DashboardTimeInRangeResponse> {
    return this.apiService.getDashboardTimeInRange(principal, patientId, days);
  }

  @Get('pending-investigation')
  async getPendingInvestigation(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<{ patient_id: string; pending_investigation: Record<string, unknown> | null }> {
    return this.apiService.getPendingInvestigation(principal, patientId);
  }

  @Get('pending-questions')
  async listPendingQuestions(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<{ patient_id: string; items: Array<Record<string, unknown>> }> {
    return this.apiService.listPendingQuestions(principal, patientId);
  }

  @Get('notifications')
  async listNotifications(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Query('limit') limit = '50',
  ): Promise<{ patient_id: string; items: NotificationHistoryRow[] }> {
    return this.apiService.listNotifications(principal, patientId, Number(limit));
  }

  @Get('recommendations/:recommendationId')
  async getRecommendation(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('recommendationId') recommendationId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.getRecommendation(principal, patientId, recommendationId);
  }

  @Get('conversations')
  async listConversations(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Query('limit') limit = '50',
    @Query('cursor') cursor: string | undefined,
  ): Promise<{ patient_id: string; items: unknown[]; next_cursor: string | null }> {
    return this.apiService.listConversations(principal, patientId, Number(limit), cursor ?? null);
  }

  @Post('conversations')
  @HttpCode(200)
  async createConversation(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ conversation: Record<string, unknown> }> {
    if (!idempotencyKey) {
      throw new ValidationError('Idempotency-Key header is required');
    }

    const result = await this.apiService.createConversation(principal, patientId, idempotencyKey);
    response.status(result.created ? 201 : 200);
    return {
      conversation: result.conversation,
    };
  }

  @Get('conversations/:conversationId')
  async getConversation(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.getConversation(principal, patientId, conversationId);
  }

  /** Deletes the conversation for every caregiver of the patient (soft delete). 204, also when already deleted. */
  @Delete('conversations/:conversationId')
  @HttpCode(204)
  async deleteConversation(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
  ): Promise<void> {
    await this.apiService.deleteConversation(principal, patientId, conversationId);
  }

  /** Renames and/or pins the conversation for every caregiver of the patient: { title?: string, pinned?: boolean }. 204. */
  @Patch('conversations/:conversationId')
  @HttpCode(204)
  async updateConversation(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: { title?: unknown; pinned?: unknown },
  ): Promise<void> {
    await this.apiService.updateConversation(principal, patientId, conversationId, body ?? {});
  }

  /** "Podano dosłodzenie" for the rescue alert of this conversation (rescue-carbs.v1); returns its `rescue_carbs`. */
  @Post('conversations/:conversationId/rescue-carbs')
  @HttpCode(200)
  async logRescueCarbs(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.apiService.logRescueCarbs(principal, patientId, conversationId, body ?? {});
  }

  /** "Zatwierdź Y g" on a rescue carb card of an ordinary conversation; returns the card with what was logged. */
  @Post('conversations/:conversationId/rescue-carb-proposals/:proposalId/accept')
  @HttpCode(200)
  async acceptChatRescueCarbs(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.apiService.acceptChatRescueCarbs(principal, patientId, conversationId, proposalId, body ?? {});
  }

  /** "Nie podaję": no rescue carbs for this conversation's alert, so no reminder; returns its `rescue_carbs`. */
  @Post('conversations/:conversationId/rescue-carbs/decline')
  @HttpCode(200)
  async declineRescueCarbs(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.declineRescueCarbs(principal, patientId, conversationId);
  }

  @Post('conversations/:conversationId/messages')
  @HttpCode(200)
  async postMessage(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: {
      message_type: 'CONTEXT_ANSWER' | 'USER_MESSAGE';
      question_id?: string;
      answer?: { type: 'YES' | 'NO' | 'UNKNOWN' | 'TEXT'; text?: string };
      content?: string;
      /** USER_MESSAGE only: photos uploaded to this conversation first (POST …/photos), at most 3. */
      photo_ids?: string[];
      /** USER_MESSAGE only: this phone can give a bolus to the patient (remote control set up), so cards may be made. */
      bolus_cards?: boolean;
      /** USER_MESSAGE only: this phone can confirm rescue carb cards outside an alert's chat. */
      rescue_cards?: boolean;
      /** USER_MESSAGE with bolus_cards: this phone's own send limits (cards above them get a warning). */
      phone_limits?: { max_bolus_u?: number; max_carbs_g?: number };
    },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ message: Record<string, unknown>; conversation: Record<string, unknown>; decision: string }> {
    if (!idempotencyKey) {
      throw new ValidationError('Idempotency-Key header is required');
    }

    const result = await this.apiService.submitAnswer(principal, patientId, conversationId, {
      ...body,
      idempotency_key: idempotencyKey,
    } as any);

    response.status(body.message_type === 'USER_MESSAGE' ? 200 : result.created ? 201 : 200);
    return {
      message: result.message,
      conversation: result.conversation,
      decision: result.decision,
    };
  }

  @Post('conversations/:conversationId/photos')
  @HttpCode(201)
  async uploadConversationPhoto(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: { content_type?: string; data_base64?: string },
  ): Promise<{ patient_id: string; photo_id: string }> {
    return this.apiService.uploadConversationPhoto(principal, patientId, conversationId, body);
  }

  /** A voice message from a chat composer as text (not stored). 409 while voice input is off on the server. */
  @Post('transcriptions')
  @HttpCode(200)
  async transcribeVoice(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Body() body: { content_type?: string; data_base64?: string },
  ): Promise<{ patient_id: string; text: string; duration_seconds: number }> {
    return this.apiService.transcribeVoice(principal, patientId, body);
  }

  @Get('conversations/:conversationId/photos/:photoId')
  async getConversationPhoto(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Param('photoId') photoId: string,
    @Res() response: Response,
  ): Promise<void> {
    const photo = await this.apiService.getConversationPhoto(principal, patientId, conversationId, photoId);
    response.setHeader('Content-Type', photo.contentType);
    response.setHeader('Cache-Control', 'private, max-age=86400');
    response.send(photo.data);
  }

  /** Cancels the analysis answering one user message. 200 with an explicit `result` for every known outcome. */
  @Post('conversations/:conversationId/messages/:messageId/cancel')
  @HttpCode(200)
  async cancelMessageAnalysis(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<{ result: string; message_id: string; conversation: Record<string, unknown> }> {
    return this.apiService.cancelMessageAnalysis(principal, patientId, conversationId, messageId);
  }

  /** Answers a caregiver message again after its answer failed. 200 with REQUEUED or NOT_FAILED and the conversation. */
  @Post('conversations/:conversationId/messages/:messageId/retry')
  @HttpCode(200)
  async retryMessageAnalysis(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<{ result: string; message_id: string; conversation: Record<string, unknown> }> {
    return this.apiService.retryMessageAnalysis(principal, patientId, conversationId, messageId);
  }

  /** Confirms a meal change the AI prepared ("Zatwierdź"); `edited` holds the values changed with "Popraw". */
  @Post('conversations/:conversationId/meal-actions/:actionId/apply')
  @HttpCode(200)
  async applyConversationMealAction(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Param('actionId') actionId: string,
    @Body() body: { edited?: { description?: string | null; carbs_g?: number | null; protein_g?: number | null; fat_g?: number | null } | null },
  ): Promise<{ patient_id: string; meal_action: Record<string, unknown> }> {
    return this.apiService.applyConversationMealAction(principal, patientId, conversationId, actionId, body ?? {});
  }

  @Post('conversations/:conversationId/meal-actions/:actionId/reject')
  @HttpCode(200)
  async rejectConversationMealAction(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Param('actionId') actionId: string,
  ): Promise<{ patient_id: string; meal_action: Record<string, unknown> }> {
    return this.apiService.rejectConversationMealAction(principal, patientId, conversationId, actionId);
  }

  /** "Cofnij": restores what a confirmed meal change replaced (409 STALE_WRITE when the meal changed again since). */
  @Post('conversations/:conversationId/meal-actions/:actionId/undo')
  @HttpCode(200)
  async undoConversationMealAction(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('conversationId') conversationId: string,
    @Param('actionId') actionId: string,
  ): Promise<{ patient_id: string; meal_action: Record<string, unknown> }> {
    return this.apiService.undoConversationMealAction(principal, patientId, conversationId, actionId);
  }

  // The new Meals tab (meal-journal.v1). Declared before meals/:mealId so "journal" and "search" are not taken for ids.
  @Get('meals/journal')
  async getMealJournal(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Query('before') before: string | undefined,
    @Query('after') after: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<Record<string, unknown>> {
    return this.apiService.getMealJournal(principal, patientId, { before, after, limit });
  }

  @Get('meals/journal/days')
  async getMealJournalDays(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): Promise<Record<string, unknown>> {
    return this.apiService.getMealJournalDays(principal, patientId, { from, to });
  }

  @Get('meals/search')
  async searchMeals(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Query('q') q: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<Record<string, unknown>> {
    return this.apiService.searchMeals(principal, patientId, { q, limit });
  }

  @Get('meals/:mealId/overview')
  async getMealOverview(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('mealId') mealId: string): Promise<Record<string, unknown>> {
    return this.apiService.getMealOverview(principal, patientId, mealId);
  }

  @Put('meals/:mealId/reminders/:reminderId')
  async setMealReminderEnabled(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Param('reminderId') reminderId: string,
    @Body() body: { enabled?: unknown },
  ): Promise<Record<string, unknown>> {
    return this.apiService.setMealReminderEnabled(principal, patientId, mealId, reminderId, body ?? {});
  }

  @Put('meals/:mealId/wbt-reminder')
  async setMealWbtReminder(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Body() body: { enabled?: boolean },
  ): Promise<{ patient_id: string; meal: Record<string, unknown> }> {
    return this.apiService.setMealWbtReminder(principal, patientId, mealId, body);
  }

  @Get('meals/:mealId/planned-bolus')
  async getMealPlannedBolus(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Query('planned_bolus_id') plannedBolusId?: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.getMealPlannedBolus(principal, patientId, mealId, plannedBolusId ?? null);
  }

  @Post('meals/:mealId/planned-bolus/skip')
  @HttpCode(200)
  async skipMealPlannedBolus(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Body() body: { planned_bolus_id?: string },
  ): Promise<Record<string, unknown>> {
    return this.apiService.skipMealPlannedBolus(principal, patientId, mealId, body);
  }

  @Post('care-reminders/:reminderId/cancel')
  @HttpCode(200)
  async cancelCareReminder(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('reminderId') reminderId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.cancelCareReminder(principal, patientId, reminderId);
  }

  @Post('meals/:mealId/wbt-suggestion')
  @HttpCode(200)
  async requestMealWbtSuggestion(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.requestMealWbtSuggestion(principal, patientId, mealId);
  }

  @Get('meals/:mealId/wbt-suggestion')
  async getMealWbtSuggestion(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.getMealWbtSuggestion(principal, patientId, mealId);
  }

  /** The meal's WBT conversation (wbt-chat.v1), created on first use: talks the WBT dose over and may propose another. */
  @Post('meals/:mealId/wbt-conversation')
  @HttpCode(200)
  async openMealWbtConversation(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.openMealWbtConversation(principal, patientId, mealId);
  }

  @Put('meals/:mealId/description')
  async updateMealDescription(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Body() body: { description?: string; expected_revision?: number },
  ): Promise<{ patient_id: string; meal: Record<string, unknown> }> {
    return this.apiService.updateMealDescription(principal, patientId, mealId, body);
  }

  @Post('meals/:mealId/photos')
  @HttpCode(201)
  async uploadMealPhoto(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Body() body: { content_type?: string; data_base64?: string },
  ): Promise<{ patient_id: string; photo_id: string }> {
    return this.apiService.uploadMealPhoto(principal, patientId, mealId, body);
  }

  @Get('meals/:mealId/photos/:photoId')
  async getMealPhoto(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Param('photoId') photoId: string,
    @Res() response: Response,
  ): Promise<void> {
    const photo = await this.apiService.getMealPhoto(principal, patientId, mealId, photoId);
    response.setHeader('Content-Type', photo.contentType);
    response.setHeader('Cache-Control', 'private, max-age=86400');
    response.send(photo.data);
  }

  @Get('meals/:mealId/chat')
  async getMealChat(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.getMealChat(principal, patientId, mealId);
  }

  @Post('meals/:mealId/chat')
  @HttpCode(200)
  async postMealChatMessage(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Body() body: { content?: string; photo_ids?: string[] },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<Record<string, unknown>> {
    return this.apiService.postMealChatMessage(principal, patientId, mealId, body, idempotencyKey ?? '');
  }

  @Post('meals/:mealId/chat/retry')
  @HttpCode(200)
  async retryMealChatReply(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.retryMealChatReply(principal, patientId, mealId);
  }

  @Post('meals/:mealId/chat/:messageId/accept')
  @HttpCode(200)
  async acceptMealChatProposal(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Param('messageId') messageId: string,
    @Body() body: { expected_revision?: number } | undefined,
  ): Promise<Record<string, unknown>> {
    return this.apiService.acceptMealChatProposal(principal, patientId, mealId, messageId, body ?? {});
  }

  @Get('meals/:mealId')
  async getMeal(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
  ): Promise<{ patient_id: string; meal: Record<string, unknown> }> {
    return this.apiService.getMeal(principal, patientId, mealId);
  }

  @Post('meals/:mealId/correct')
  @HttpCode(200)
  async correctMeal(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('mealId') mealId: string,
    @Body() body: { carbs_g?: number | null; protein_g?: number | null; fat_g?: number | null; expected_revision?: number },
  ): Promise<{ patient_id: string; meal: Record<string, unknown> }> {
    return this.apiService.correctMealMacros(principal, patientId, mealId, body ?? {});
  }

  /** The patient's year of birth ("Rok urodzenia"). */
  @Put('birth-year')
  async setPatientBirthYear(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Body() body: unknown,
  ): Promise<{ patient_id: string; birth_year: number }> {
    return this.apiService.setPatientBirthYear(principal, patientId, body ?? {});
  }

  /** This phone's notification switches: rescue_carb_alerts_enabled ("Ostrzeżenia o możliwym hipo") and
   * answer_ready_push_enabled ("Gotowa odpowiedź"). */
  @Get('devices/:deviceId/notification-settings')
  async getDeviceNotificationSettings(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('deviceId') deviceId: string,
  ): Promise<Record<string, unknown>> {
    return this.apiService.getDeviceNotificationSettings(principal, patientId, deviceId);
  }

  @Put('devices/:deviceId/notification-settings')
  async setDeviceNotificationSettings(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('deviceId') deviceId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.apiService.setDeviceNotificationSettings(principal, patientId, deviceId, body ?? {});
  }

  /** This phone's glucose Live Activity: its switch ("Glukoza na ekranie blokady"), push-to-start token and the
   * running activity's update token (live-activity.v1). Fields left out keep their value. */
  @Put('devices/:deviceId/live-activity')
  async setLiveActivity(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Param('deviceId') deviceId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.apiService.setLiveActivity(principal, patientId, deviceId, body ?? {});
  }

  @Post('devices')
  @HttpCode(200)
  async registerDevice(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Body() body: { platform: 'ios'; device_id: string; push_token: string; app_version?: string; release_secret?: unknown },
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ device: Record<string, unknown> }> {
    const result = await this.apiService.registerDevice(principal, patientId, body);
    response.status(result.created ? 201 : 200);
    return {
      device: result.device,
    };
  }
}