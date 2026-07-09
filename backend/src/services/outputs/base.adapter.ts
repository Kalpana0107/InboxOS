export interface BaseOutputAdapter {
  /**
   * Send a notification to the user via this output adapter.
   * @param userId The ID of the user receiving the notification
   * @param emailSummary The summary object of the email or notification content
   * @returns Promise resolving to a boolean indicating success
   */
  sendNotification(userId: string, emailSummary: any): Promise<boolean>;
}
